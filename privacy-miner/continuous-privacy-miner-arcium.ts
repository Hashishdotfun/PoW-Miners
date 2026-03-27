#!/usr/bin/env ts-node
/**
 * Continuous Privacy GPU Miner with Arcium MPC
 *
 * Dashboard TUI (like continuous-gpu-miner) + interactive menu.
 *
 * Architecture:
 * - MINER (fixed): wallet whose encrypted SOL+HASHISH balances are tracked in MPC
 * - RELAYERS (pool, random): wallets that pay tx fees for mining submissions
 * - CLAIMERS (pool): destination wallets for HASHISH withdrawals
 *
 * Flow:
 * 1. Mine with GPU (privacyAuthority as miner pubkey)
 * 2. Pick random relayer to submit block
 * 3. submit_block_private → mints to sharedTokenVault + MPC mine_block (deducts SOL fee)
 * 4. deposit_token_private → credits HASHISH reward to encrypted token balance
 * 5. User withdraws HASHISH to claimer wallets via menu
 *
 * Menu sections:
 * [1] Miners & Funds   - change miner, deposit/withdraw SOL, deposit HASHISH
 * [2] Relayers          - add/remove/list relayers
 * [3] Claimers          - add/remove/list claimers, withdraw HASHISH to claimer
 * [S] Stop              - exit
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import {
  getMXEAccAddress,
  getMXEPublicKey,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  awaitComputationFinalization,
  x25519,
  RescueCipher,
  deserializeLE,
  getArciumProgramId,
  getFeePoolAccAddress,
  getClockAccAddress,
} from "@arcium-hq/client";
import { spawn, ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import readline from "readline";
import * as db from "./privacy-db";

// ============================================================================
// CONFIG
// ============================================================================

const useLocal = process.argv.includes("--local");
const configPath = useLocal
  ? __dirname + "/../miner-config.json"
  : __dirname + "/../miner-config.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const networkLabel = useLocal ? "localhost" : "devnet";
const gpuBackend = String(config.gpu_backend ?? process.env.POW_GPU_BACKEND ?? "cuda");
const challengePollIntervalMs = Math.max(500, Number(config.challenge_poll_interval_ms ?? 1500) || 1500);
const gpuDevice = Math.max(0, Math.floor(Number(config.gpu_device ?? process.env.POW_GPU_DEVICE ?? 0) || 0));
const cudaThreadsPerBlock = (() => {
  const v = Number(config.cuda_threads_per_block ?? process.env.POW_CUDA_THREADS_PER_BLOCK);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
})();
const cudaNumBlocks = (() => {
  const v = Number(config.cuda_num_blocks ?? process.env.POW_CUDA_NUM_BLOCKS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
})();

// Program IDs (from Anchor.toml devnet)
const POW_PRIVACY_ID = new PublicKey("AMmu8GcoNUAdnRNKU5AqgNGdLJSLh9WLxxzxFkdtXwCh");
const POW_PROTOCOL_ID = new PublicKey("8ShwcqBzuknRJdGP2HoupsMEAMjvyqqwjjWWQmJVHChG");
const TRANSFER_HOOK_PROGRAM_ID = new PublicKey("95zaGUMvrNFnCpjSqQyTNw3msyJtj9drQ5mWYm1eP6S3");
const MINT = new PublicKey(config.mint);

// Arcium
const DEFAULT_CLUSTER_OFFSET = 456;
const ARCIUM_CLUSTER_OFFSET = Number.isFinite(Number(process.env.ARCIUM_CLUSTER_OFFSET))
  ? Number(process.env.ARCIUM_CLUSTER_OFFSET)
  : DEFAULT_CLUSTER_OFFSET;
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const ARCIUM_FEE_POOL = getFeePoolAccAddress();
const ARCIUM_CLOCK = getClockAccAddress();

// Seeds
const POW_CONFIG_SEED = Buffer.from("pow_config");
const POW_FEE_VAULT_SEED = Buffer.from("fee_vault");
const POW_MINER_STATS_SEED = Buffer.from("miner_stats");
const POW_MINT_AUTHORITY_SEED = Buffer.from("pow_mint_auth");
const PRIVACY_CONFIG_SEED = Buffer.from("privacy_config");
const PRIVACY_AUTHORITY_SEED = Buffer.from("privacy_authority");
const SHARED_TOKEN_VAULT_SEED = Buffer.from("shared_token_vault");
const SHARED_FEE_VAULT_SEED = Buffer.from("shared_fee_vault");
const DEPOSIT_BUFFER_SEED = Buffer.from("deposit_buffer");
const WITHDRAW_BUFFER_SEED = Buffer.from("withdraw_buffer");
const DEPOSIT_TOKEN_BUFFER_SEED = Buffer.from("deposit_token_buffer");
const WITHDRAW_TOKEN_BUFFER_SEED = Buffer.from("withdraw_token_buffer");
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

const POOL_NORMAL = 0;
const POOL_SEEKER = 1;

// Dashboard
const DASHBOARD_MIN_WIDTH = 76;
const DASHBOARD_MAX_WIDTH = 104;
const DASHBOARD_EVENT_LINES = 6;
const POST_WIN_PAUSE_MS = 600;
const RETRY_DELAY_MS = 5000;

// ============================================================================
// TYPES
// ============================================================================

type ProtocolState = {
  difficulty: bigint;
  blocksMined: bigint;
  challenge: Buffer;
  challengeHex: string;
};

type GpuMineResult =
  | { status: "success"; nonce: bigint; hashrate: number; timeMs: number }
  | { status: "stopped" }
  | { status: "error"; reason: string; output?: string };

type GpuProgress = { hashesChecked: bigint; liveHashrate: number; avgHashrate: number };

type MinerPhase = "booting" | "syncing" | "ready" | "mining" | "submitting" | "depositing" | "won" | "lost" | "error" | "menu";

type DashboardState = {
  network: string;
  backend: string;
  minerWallet: string;
  relayerWallet: string;
  rpcUrl: string;
  phase: MinerPhase;
  phaseDetail: string;
  phaseStartedAt: number;
  sessionStartedAt: number;
  spinnerIndex: number;
  currentState: ProtocolState | null;
  currentNonce: bigint | null;
  currentMiningStartedAt: number | null;
  blocksWon: number;
  staleBlocks: number;
  restartCount: number;
  errorCount: number;
  liveHashrate: number | null;
  liveAvgHashrate: number | null;
  liveHashesChecked: bigint | null;
  lastHashrate: number | null;
  totalHashrate: number;
  hashrateSamples: number;
  lastMiningTimeMs: number | null;
  lastTx: string | null;
  relayerCount: number;
  claimerCount: number;
  events: string[];
};

// ============================================================================
// GLOBAL STATE
// ============================================================================

let isMining = true;
let menuActive = false;
let currentMiningProcess: ChildProcess | null = null;
let minerWalletPath = db.getMinerWalletPath() ?? config.wallet_path;
let currentRpcUrl = db.getRpcUrl() ?? config.rpc_url;

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatBigInt(v: bigint): string { return v.toLocaleString("en-US"); }
function formatHashrate(v: number | null): string { return v === null ? "-" : `${v.toFixed(2)} MH/s`; }
function formatShort(v: string, h = 8, t = 6): string {
  return v.length <= h + t + 3 ? v : `${v.slice(0, h)}...${v.slice(-t)}`;
}
function truncate(v: string, max: number): string {
  return v.length <= max ? v : max <= 3 ? v.slice(0, max) : `${v.slice(0, max - 3)}...`;
}

// ============================================================================
// DASHBOARD TUI
// ============================================================================

const renderer = { previousLines: [] as string[], active: false, cursorHidden: false };

function dashboardWidth(): number {
  return process.stdout.isTTY
    ? Math.min(DASHBOARD_MAX_WIDTH, Math.max(DASHBOARD_MIN_WIDTH, process.stdout.columns ?? DASHBOARD_MIN_WIDTH))
    : 88;
}

function boxLine(content: string, w: number): string {
  return `\u2502 ${truncate(content, w - 4).padEnd(w - 4)} \u2502`;
}

function dblCol(left: string, right: string, w: number): string {
  const inner = w - 4;
  const mid = Math.floor(inner / 2);
  return `\u2502 ${truncate(left, mid - 1).padEnd(mid - 1)} ${truncate(right, inner - mid).padEnd(inner - mid)} \u2502`;
}

function buildDashboard(d: DashboardState): string[] {
  if (!process.stdout.isTTY) return [];
  const w = dashboardWidth();
  const spin = ["-", "\\", "|", "/"];
  d.spinnerIndex = (d.spinnerIndex + 1) % spin.length;
  const sp = d.phase === "mining" ? spin[d.spinnerIndex] : " ";
  const s = d.currentState;
  const avgHr = d.hashrateSamples > 0 ? d.totalHashrate / d.hashrateSamples : null;
  const uptime = formatDuration(Date.now() - d.sessionStartedAt);
  const phaseAge = formatDuration(Date.now() - d.phaseStartedAt);
  const mineElapsed = d.currentMiningStartedAt ? formatDuration(Date.now() - d.currentMiningStartedAt) : "-";
  const title = " PRIVACY GPU MINER ";
  const topRule = "\u2500".repeat(Math.max(0, w - title.length - 2));
  const challenge = s ? `${s.challengeHex.slice(0, 20)}...${s.challengeHex.slice(-8)}` : "-";
  const block = s ? formatBigInt(s.blocksMined) : "-";
  const diff = s ? formatBigInt(s.difficulty) : "-";

  const lines = [
    `\u250C${title}${topRule}\u2510`,
    boxLine(`${sp} ${d.phase.toUpperCase()}  ${d.phaseDetail}`, w),
    dblCol(`Phase for : ${phaseAge}`, `Uptime : ${uptime}`, w),
    dblCol(`Network   : ${d.network}`, `Backend : ${d.backend}`, w),
    dblCol(`Miner     : ${formatShort(d.minerWallet)}`, `RPC : ${formatShort(d.rpcUrl, 20, 8)}`, w),
    dblCol(`Relayer   : ${formatShort(d.relayerWallet)}`, `Relayers : ${d.relayerCount}`, w),
    dblCol(`Block     : ${block}`, `Difficulty : ${diff}`, w),
    boxLine(`Challenge  : ${challenge}`, w),
    dblCol(`Mining for: ${mineElapsed}`, `Live : ${formatHashrate(d.liveHashrate)}`, w),
    dblCol(`Checked   : ${d.liveHashesChecked ? formatBigInt(d.liveHashesChecked) : "-"}`, `Live avg : ${formatHashrate(d.liveAvgHashrate)}`, w),
    dblCol(`Last nonce: ${d.currentNonce === null ? "-" : d.currentNonce.toString()}`, `Last tx : ${d.lastTx ? formatShort(d.lastTx, 10, 8) : "-"}`, w),
    dblCol(`Last round: ${d.lastMiningTimeMs ? `${(d.lastMiningTimeMs / 1000).toFixed(2)}s` : "-"}`, `GPU dev : ${gpuDevice}`, w),
    dblCol(
      `Session   : wins ${d.blocksWon} | stale ${d.staleBlocks}`,
      `Claimers : ${d.claimerCount}`,
      w,
    ),
    dblCol(`Hashrate  : last ${formatHashrate(d.lastHashrate)}`, `avg ${formatHashrate(avgHr)}`, w),
    `\u251C${"\u2500".repeat(w - 2)}\u2524`,
    boxLine("Recent events  [M] Menu  [Ctrl+C] Quit", w),
  ];
  const evts = d.events.length > 0 ? d.events : ["No events yet."];
  for (let i = 0; i < DASHBOARD_EVENT_LINES; i++) lines.push(boxLine(evts[i] ?? "", w));
  lines.push(`\u2514${"\u2500".repeat(w - 2)}\u2518`);
  return lines;
}

function renderDashboard(d: DashboardState) {
  if (!process.stdout.isTTY || menuActive) return;
  const lines = buildDashboard(d);
  if (lines.length === 0) return;

  if (!renderer.active) {
    if (!renderer.cursorHidden) { process.stdout.write("\x1b[?25l"); renderer.cursorHidden = true; }
    process.stdout.write(`${lines.join("\n")}\n`);
    renderer.previousLines = lines;
    renderer.active = true;
    return;
  }

  readline.moveCursor(process.stdout, 0, -renderer.previousLines.length);
  for (let i = 0; i < lines.length; i++) {
    readline.cursorTo(process.stdout, 0);
    if (renderer.previousLines[i] !== lines[i]) {
      readline.clearLine(process.stdout, 0);
      process.stdout.write(lines[i]);
    }
    if (i < lines.length - 1) readline.moveCursor(process.stdout, 0, 1);
  }
  readline.cursorTo(process.stdout, 0);
  process.stdout.write("\n");
  renderer.previousLines = lines;
}

function startDashboardRenderer(d: DashboardState): () => void {
  if (!process.stdout.isTTY) return () => undefined;
  renderDashboard(d);
  const timer = setInterval(() => { if (!menuActive) renderDashboard(d); }, 1000);
  return () => {
    clearInterval(timer);
    if (renderer.cursorHidden) { process.stdout.write("\x1b[?25h"); renderer.cursorHidden = false; }
    renderer.active = false;
    renderer.previousLines = [];
  };
}

function setPhase(d: DashboardState, phase: MinerPhase, detail: string) {
  d.phase = phase;
  d.phaseDetail = detail;
  d.phaseStartedAt = Date.now();
  if (phase === "mining") {
    d.currentMiningStartedAt = Date.now();
  } else {
    d.currentMiningStartedAt = null;
    d.liveHashrate = null;
    d.liveAvgHashrate = null;
    d.liveHashesChecked = null;
  }
}

function pushEvent(d: DashboardState, msg: string) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  d.events = [`${time}  ${msg}`, ...d.events].slice(0, DASHBOARD_EVENT_LINES);
}

function createDashboardState(): DashboardState {
  return {
    network: networkLabel, backend: gpuBackend.toUpperCase(),
    minerWallet: "-", relayerWallet: "-", rpcUrl: currentRpcUrl,
    phase: "booting", phaseDetail: "Loading...",
    phaseStartedAt: Date.now(), sessionStartedAt: Date.now(), spinnerIndex: 0,
    currentState: null, currentNonce: null, currentMiningStartedAt: null,
    blocksWon: 0, staleBlocks: 0, restartCount: 0, errorCount: 0,
    liveHashrate: null, liveAvgHashrate: null, liveHashesChecked: null,
    lastHashrate: null, totalHashrate: 0, hashrateSamples: 0,
    lastMiningTimeMs: null, lastTx: null,
    relayerCount: 0, claimerCount: 0, events: [],
  };
}

// ============================================================================
// PROTOCOL STATE
// ============================================================================

async function readProtocolState(connection: anchor.web3.Connection, powConfig: PublicKey): Promise<ProtocolState> {
  const info = await connection.getAccountInfo(powConfig);
  if (!info) throw new Error("PoW config not found");
  const data = info.data;
  const dLow = data.readBigUInt64LE(72);
  const dHigh = data.readBigUInt64LE(80);
  return {
    difficulty: BigInt(dLow) | (BigInt(dHigh) << 64n),
    blocksMined: data.readBigUInt64LE(96),
    challenge: Buffer.from(data.slice(112, 144)),
    challengeHex: Buffer.from(data.slice(112, 144)).toString("hex"),
  };
}

// ============================================================================
// GPU MINING
// ============================================================================

function killMiningProcess() {
  if (currentMiningProcess) { currentMiningProcess.kill("SIGTERM"); currentMiningProcess = null; }
}

function startGpuMiner(
  challengeHex: string, minerPubkeyHex: string, blockNumber: bigint, difficulty: bigint,
  onProgress?: (p: GpuProgress) => void,
): { promise: Promise<GpuMineResult>; kill: () => void } {
  const minerBinary = __dirname + "/../gpu-miner/target/release/miner";
  if (!fs.existsSync(minerBinary)) {
    return { promise: Promise.resolve({ status: "error", reason: "GPU binary not found" }), kill: () => {} };
  }

  const isWSL = fs.existsSync("/usr/lib/wsl/lib");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), RUST_LOG: "info" };
  if (isWSL) env.LD_LIBRARY_PATH = "/usr/lib/wsl/lib";

  const args = [
    "--benchmark", "--backend", gpuBackend, "--device", String(gpuDevice),
    "--difficulty", difficulty.toString(), "--challenge", challengeHex,
    "--block-number", blockNumber.toString(), "--miner-pubkey", minerPubkeyHex,
  ];
  if (gpuBackend === "cuda") {
    if (cudaThreadsPerBlock !== null) args.push("--cuda-threads-per-block", String(cudaThreadsPerBlock));
    if (cudaNumBlocks !== null) args.push("--cuda-num-blocks", String(cudaNumBlocks));
  }

  const child = spawn(minerBinary, args, { env });
  currentMiningProcess = child;
  let killed = false;
  let output = "";
  let lineBuffer = "";

  const parseLine = (line: string) => {
    const m = line.match(/Progress:\s+(\d+)\s+hashes\s+\|\s+Live:\s+([\d.]+)\s+MH\/s\s+\|\s+Avg:\s+([\d.]+)\s+MH\/s/);
    if (m) onProgress?.({ hashesChecked: BigInt(m[1]), liveHashrate: parseFloat(m[2]), avgHashrate: parseFloat(m[3]) });
  };

  const consume = (chunk: string) => {
    output += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const l of lines) parseLine(l);
  };

  child.stdout.on("data", (d: Buffer) => consume(d.toString()));
  child.stderr.on("data", (d: Buffer) => consume(d.toString()));

  const promise = new Promise<GpuMineResult>((resolve) => {
    child.on("close", (code) => {
      if (lineBuffer.trim()) parseLine(lineBuffer);
      currentMiningProcess = null;
      if (killed) { resolve({ status: "stopped" }); return; }
      if (code !== 0) { resolve({ status: "error", reason: `Exit code ${code}`, output }); return; }
      const nm = output.match(/Nonce found:\s+(\d+)/);
      const tm = output.match(/Time:\s+([\d.]+)(\u00b5s|ms|s)/);
      const hm = output.match(/Hashrate:\s+([\d.]+)\s+MH\/s/);
      if (!nm || !tm || !hm) { resolve({ status: "error", reason: "Parse error", output }); return; }
      const tv = parseFloat(tm[1]);
      const u = tm[2];
      const ms = u === "s" ? tv * 1000 : u === "ms" ? tv : tv / 1000;
      resolve({ status: "success", nonce: BigInt(nm[1]), hashrate: parseFloat(hm[1]), timeMs: ms });
    });
    child.on("error", (e) => { currentMiningProcess = null; resolve({ status: "error", reason: e.message }); });
  });

  return {
    promise,
    kill: () => { if (!killed) { killed = true; child.kill("SIGTERM"); } },
  };
}

function createChallengeMonitor(
  connection: anchor.web3.Connection, powConfig: PublicKey,
  baseline: ProtocolState, pollMs: number,
): { changed: Promise<ProtocolState | null>; stop: () => void } {
  let stopped = false, settled = false, inFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let res: (v: ProtocolState | null) => void = () => {};

  const settle = (v: ProtocolState | null) => {
    if (settled) return;
    settled = true;
    if (timer) { clearInterval(timer); timer = null; }
    res(v);
  };

  const changed = new Promise<ProtocolState | null>((r) => { res = r; });

  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const fresh = await readProtocolState(connection, powConfig);
      if (fresh.blocksMined !== baseline.blocksMined || fresh.challengeHex !== baseline.challengeHex) {
        stopped = true;
        settle(fresh);
      }
    } catch {} finally { inFlight = false; }
  };

  timer = setInterval(() => { void poll(); }, pollMs);
  void poll();

  return { changed, stop: () => { if (!stopped) { stopped = true; } settle(null); } };
}

async function waitForStateAdvance(
  connection: anchor.web3.Connection, powConfig: PublicKey,
  baseline: ProtocolState, timeoutMs: number,
): Promise<ProtocolState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fresh = await readProtocolState(connection, powConfig);
      if (fresh.blocksMined !== baseline.blocksMined || fresh.challengeHex !== baseline.challengeHex) return fresh;
    } catch {}
    await sleep(800);
  }
  return null;
}

// ============================================================================
// ENCRYPTION HELPERS
// ============================================================================

function encryptAmount(amount: bigint, mxePk: Uint8Array, clientSk: Uint8Array, nonce: Buffer): Uint8Array {
  const shared = x25519.getSharedSecret(clientSk, mxePk);
  const cipher = new RescueCipher(shared);
  return Uint8Array.from(cipher.encrypt([amount], nonce)[0]);
}

function encryptCurrentState(
  balance: bigint, stateNonce: bigint, reserved: bigint,
  mxePk: Uint8Array, clientSk: Uint8Array, nonce: Buffer,
): Uint8Array[] {
  const shared = x25519.getSharedSecret(clientSk, mxePk);
  const cipher = new RescueCipher(shared);
  return cipher.encrypt([balance, stateNonce, reserved], nonce).map((c: any) => Uint8Array.from(c));
}

function encryptCurrentTokenState(
  tokenBalance: bigint, tokenNonce: bigint, tokenReserved: bigint,
  mxePk: Uint8Array, clientSk: Uint8Array, nonce: Buffer,
): Uint8Array[] {
  return encryptCurrentState(tokenBalance, tokenNonce, tokenReserved, mxePk, clientSk, nonce);
}

function encryptDestination(
  dest: PublicKey, mxePk: Uint8Array, clientSk: Uint8Array, nonce: Buffer,
): Uint8Array[] {
  const shared = x25519.getSharedSecret(clientSk, mxePk);
  const cipher = new RescueCipher(shared);
  const b = dest.toBuffer();
  const vals = [
    BigInt("0x" + Buffer.from(b.slice(0, 8)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(b.slice(8, 16)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(b.slice(16, 24)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(b.slice(24, 32)).reverse().toString("hex")),
  ];
  return cipher.encrypt(vals, nonce).map((c: any) => Uint8Array.from(c));
}

// ============================================================================
// MENU SYSTEM
// ============================================================================

async function promptUser(question: string): Promise<string> {
  // Disable raw mode for readline prompt
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function printMainMenu() {
  console.log("\n");
  console.log("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551                    PRIVACY MINER MENU                      \u2551");
  console.log("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
  console.log("\u2551  [1] Miners & Funds  - Miner wallet, deposit/withdraw      \u2551");
  console.log("\u2551  [2] Relayers        - Add/remove/list relayer wallets      \u2551");
  console.log("\u2551  [3] Claimers        - Withdraw HASHISH to destinations     \u2551");
  console.log("\u2551  [S] Stop            - Stop mining and exit                 \u2551");
  console.log("\u2551  [M] Close Menu      - Return to mining                     \u2551");
  console.log("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D");
  console.log("");
}

// ── MINERS & FUNDS ──

async function handleMinersMenu(ctx: MiningContext) {
  while (true) {
    const state = db.loadMinerState();
    console.log("\n--- MINERS & FUNDS ---");
    console.log(`  Miner wallet: ${minerWalletPath}`);
    try {
      const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8"))));
      const bal = await ctx.connection.getBalance(kp.publicKey);
      console.log(`  Address: ${kp.publicKey.toString()}`);
      console.log(`  SOL balance (on-chain): ${(bal / 1e9).toFixed(6)} SOL`);
    } catch { console.log("  (Unable to load)"); }
    console.log(`  Encrypted SOL balance: ${state.balance.toString()} lamports`);
    console.log(`  Encrypted HASHISH balance: ${state.tokenBalance.toString()} tokens`);
    console.log("\n  [1] Change miner wallet");
    console.log("  [D] Deposit SOL");
    console.log("  [W] Withdraw SOL");
    console.log("  [B] Back");

    const choice = (await promptUser("  > ")).toUpperCase();
    if (choice === "B" || choice === "") break;
    if (choice === "1") await handleChangeMiner();
    else if (choice === "D") await handleDepositSol(ctx);
    else if (choice === "W") await handleWithdrawSol(ctx);
    else console.log("  Invalid choice.");
  }
}

async function handleChangeMiner() {
  const newPath = await promptUser("  Enter new miner wallet path (empty to cancel): ");
  if (!newPath) return;
  if (!fs.existsSync(newPath)) { console.log("  File not found."); return; }
  try {
    const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(newPath, "utf-8"))));
    minerWalletPath = newPath;
    db.setMinerWalletPath(newPath);
    console.log(`  Miner changed to: ${kp.publicKey.toString()}`);
    console.log("  RESTART the miner for the change to take full effect.");
  } catch { console.log("  Invalid keypair file."); }
}

async function handleDepositSol(ctx: MiningContext) {
  const amtStr = await promptUser("  Amount in SOL: ");
  const sol = parseFloat(amtStr);
  if (isNaN(sol) || sol <= 0) { console.log("  Invalid amount."); return; }
  const lamports = Math.floor(sol * 1e9);

  try {
    const minerKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8"))));
    const minerWallet = new anchor.Wallet(minerKp);
    const minerProvider = new anchor.AnchorProvider(ctx.connection, minerWallet, { commitment: "confirmed" });
    const program = new Program(ctx.privacyIdl, minerProvider);

    const clientSk = x25519.utils.randomSecretKey();
    const clientPk = x25519.getPublicKey(clientSk);
    const nonce = randomBytes(16);
    const state = db.loadMinerState();

    const encAmt = encryptAmount(BigInt(lamports), ctx.mxePublicKey, clientSk, nonce);
    const encState = encryptCurrentState(state.balance, state.stateNonce, state.reserved, ctx.mxePublicKey, clientSk, nonce);

    const [bufferPda] = PublicKey.findProgramAddressSync(
      [DEPOSIT_BUFFER_SEED, minerWallet.publicKey.toBuffer(), encAmt.slice(0, 8)], POW_PRIVACY_ID,
    );

    console.log("  Creating deposit buffer...");
    await program.methods
      .createDepositBuffer(Array.from(encAmt), encState.map((c) => Array.from(c)),
        Array.from(clientPk), new anchor.BN(deserializeLE(nonce).toString()), new anchor.BN(lamports))
      .accounts({ depositor: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, depositBuffer: bufferPda, systemProgram: SystemProgram.programId })
      .rpc();

    console.log("  Executing deposit via MPC...");
    const compOffset = new anchor.BN(randomBytes(8), "hex");
    const defOffset = Buffer.from(getCompDefAccOffset("deposit_fee")).readUInt32LE();
    const compDef = getCompDefAccAddress(POW_PRIVACY_ID, defOffset);
    const compAcc = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, compOffset);

    await program.methods.depositPrivate(compOffset)
      .accounts({
        depositor: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, depositBuffer: bufferPda,
        owner: minerWallet.publicKey, sharedFeeVault: ctx.sharedFeeVault, systemProgram: SystemProgram.programId,
        signPdaAccount: ctx.signPdaAccount, mxeAccount: ctx.mxeAccount, mempoolAccount: ctx.mempoolAccount,
        executingPool: ctx.executingPool, computationAccount: compAcc, compDefAccount: compDef,
        clusterAccount: ctx.clusterAccount, poolAccount: ARCIUM_FEE_POOL, clockAccount: ARCIUM_CLOCK,
        arciumProgram: ARCIUM_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc({ skipPreflight: true });

    console.log("  Waiting for MPC...");
    try {
      await awaitComputationFinalization(minerProvider, compOffset, POW_PRIVACY_ID, "confirmed");
      // Update local state
      const s = db.loadMinerState();
      s.balance += BigInt(lamports);
      s.stateNonce += 1n;
      db.saveMinerState(s);
      console.log(`  Deposit successful! ${sol} SOL added.`);
    } catch { console.log("  MPC timeout - may complete in background."); }
  } catch (e: any) { console.error("  Deposit failed:", e?.message || e); }
}

async function handleWithdrawSol(ctx: MiningContext) {
  const amtStr = await promptUser("  Amount in SOL: ");
  const sol = parseFloat(amtStr);
  if (isNaN(sol) || sol <= 0) { console.log("  Invalid amount."); return; }
  const lamports = Math.floor(sol * 1e9);

  let destStr = await promptUser("  Destination address (empty for new random): ");
  let destination: PublicKey;
  if (!destStr) {
    const kp = Keypair.generate();
    destination = kp.publicKey;
    const dir = __dirname + "/../wallets-privacy";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(`${dir}/withdraw-${Date.now()}.json`, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`  New wallet saved: ${destination.toString()}`);
  } else {
    try { destination = new PublicKey(destStr); } catch { console.log("  Invalid address."); return; }
  }

  try {
    const minerKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8"))));
    const minerWallet = new anchor.Wallet(minerKp);
    const minerProvider = new anchor.AnchorProvider(ctx.connection, minerWallet, { commitment: "confirmed" });
    const program = new Program(ctx.privacyIdl, minerProvider);

    const clientSk = x25519.utils.randomSecretKey();
    const clientPk = x25519.getPublicKey(clientSk);
    const nonce = randomBytes(16);
    const state = db.loadMinerState();

    const encAmt = encryptAmount(BigInt(lamports), ctx.mxePublicKey, clientSk, nonce);
    const encDest = encryptDestination(destination, ctx.mxePublicKey, clientSk, nonce);
    const encState = encryptCurrentState(state.balance, state.stateNonce, state.reserved, ctx.mxePublicKey, clientSk, nonce);

    const [bufferPda] = PublicKey.findProgramAddressSync(
      [WITHDRAW_BUFFER_SEED, minerWallet.publicKey.toBuffer(), encAmt.slice(0, 8)], POW_PRIVACY_ID,
    );

    console.log("  Creating withdraw buffer...");
    await program.methods
      .createWithdrawBuffer(
        Array.from(encAmt), encDest.map((c) => Array.from(c)), encState.map((c) => Array.from(c)),
        Array.from(clientPk), new anchor.BN(deserializeLE(nonce).toString()), new anchor.BN(lamports),
      )
      .accounts({ creator: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, withdrawBuffer: bufferPda, systemProgram: SystemProgram.programId })
      .rpc();

    // Get team_wallet from privacyConfig
    const privacyProgram = new Program(ctx.privacyIdl, minerProvider);
    const configAccount = await (privacyProgram.account as any).privacyConfig.fetch(ctx.privacyConfig);
    const teamWallet = configAccount.teamWallet as PublicKey;

    console.log("  Executing withdrawal via MPC...");
    const compOffset = new anchor.BN(randomBytes(8), "hex");
    const defOffset = Buffer.from(getCompDefAccOffset("withdraw_fee")).readUInt32LE();
    const compDef = getCompDefAccAddress(POW_PRIVACY_ID, defOffset);
    const compAcc = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, compOffset);

    await program.methods.withdrawPrivate(compOffset)
      .accounts({
        caller: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, withdrawBuffer: bufferPda,
        sharedFeeVault: ctx.sharedFeeVault, destination, teamWallet,
        systemProgram: SystemProgram.programId, signPdaAccount: ctx.signPdaAccount,
        mxeAccount: ctx.mxeAccount, mempoolAccount: ctx.mempoolAccount,
        executingPool: ctx.executingPool, computationAccount: compAcc, compDefAccount: compDef,
        clusterAccount: ctx.clusterAccount, poolAccount: ARCIUM_FEE_POOL, clockAccount: ARCIUM_CLOCK,
        arciumProgram: ARCIUM_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc({ skipPreflight: true });

    console.log("  Waiting for MPC...");
    try {
      await awaitComputationFinalization(minerProvider, compOffset, POW_PRIVACY_ID, "confirmed");
      const s = db.loadMinerState();
      s.balance -= BigInt(lamports);
      s.stateNonce += 1n;
      db.saveMinerState(s);
      console.log(`  Withdrawal successful! ${sol} SOL to ${destination.toString()}`);
    } catch { console.log("  MPC timeout - may complete in background."); }
  } catch (e: any) { console.error("  Withdrawal failed:", e?.message || e); }
}

// ── RELAYERS ──

async function handleRelayersMenu(ctx: MiningContext) {
  while (true) {
    const relayers = db.getAllRelayers();
    console.log("\n--- RELAYERS ---");
    if (relayers.length === 0) {
      console.log("  No relayers configured. Add one to start mining.");
    } else {
      for (const r of relayers) {
        try {
          const bal = await ctx.connection.getBalance(new PublicKey(r.pubkey));
          console.log(`  [${r.id}] ${r.name} | ${formatShort(r.pubkey)} | ${(bal / 1e9).toFixed(4)} SOL | ${r.is_active ? "active" : "inactive"}`);
        } catch {
          console.log(`  [${r.id}] ${r.name} | ${formatShort(r.pubkey)} | ? SOL | ${r.is_active ? "active" : "inactive"}`);
        }
      }
    }
    console.log("\n  [A] Add relayer");
    console.log("  [R] Remove relayer");
    console.log("  [B] Back");

    const choice = (await promptUser("  > ")).toUpperCase();
    if (choice === "B" || choice === "") break;
    if (choice === "A") {
      const name = await promptUser("  Name: ");
      if (!name) continue;
      const path = await promptUser("  Wallet path: ");
      if (!path || !fs.existsSync(path)) { console.log("  File not found."); continue; }
      const r = db.addRelayer(name, path);
      if (r) console.log(`  Added: ${r.name} (${r.pubkey})`);
      else console.log("  Failed to add (invalid keypair?).");
    } else if (choice === "R") {
      const idStr = await promptUser("  Relayer ID to remove: ");
      const id = parseInt(idStr, 10);
      if (isNaN(id)) continue;
      if (db.removeRelayer(id)) console.log("  Removed.");
      else console.log("  Not found.");
    }
  }
}

// ── CLAIMERS ──

async function handleClaimersMenu(ctx: MiningContext) {
  while (true) {
    const claimers = db.getAllClaimers();
    const state = db.loadMinerState();
    // Read mint decimals for human-readable display
    let decimals = 9;
    try {
      const mi = await ctx.connection.getAccountInfo(MINT);
      if (mi) decimals = mi.data[44];
    } catch {}
    const encBalHuman = (Number(state.tokenBalance) / Math.pow(10, decimals)).toFixed(decimals);
    console.log("\n--- CLAIMERS (HASHISH Withdraw) ---");
    console.log(`  Encrypted HASHISH balance: ${encBalHuman} HASHISH (raw: ${state.tokenBalance.toString()})`);

    if (claimers.length === 0) {
      console.log("  No claimers configured.");
    } else {
      for (const c of claimers) {
        try {
          const ata = getAssociatedTokenAddressSync(MINT, new PublicKey(c.pubkey), false, ctx.tokenProgramId);
          const ataInfo = await ctx.connection.getTokenAccountBalance(ata);
          const bal = ataInfo.value.uiAmountString ?? "0";
          console.log(`  [${c.id}] ${c.name} | ${formatShort(c.pubkey)} | ${bal} HASHISH (on-chain)`);
        } catch {
          console.log(`  [${c.id}] ${c.name} | ${formatShort(c.pubkey)} | 0 HASHISH (on-chain)`);
        }
      }
    }

    console.log("\n  [A] Add claimer");
    console.log("  [R] Remove claimer");
    console.log("  [W] Withdraw HASHISH to claimer");
    console.log("  [B] Back");

    const choice = (await promptUser("  > ")).toUpperCase();
    if (choice === "B" || choice === "") break;
    if (choice === "A") {
      const name = await promptUser("  Name: ");
      if (!name) continue;
      const pubkeyStr = await promptUser("  Pubkey (or wallet path): ");
      if (!pubkeyStr) continue;
      let pubkey: string;
      let walletPath: string | undefined;
      if (fs.existsSync(pubkeyStr)) {
        try {
          const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(pubkeyStr, "utf-8"))));
          pubkey = kp.publicKey.toString();
          walletPath = pubkeyStr;
        } catch { console.log("  Invalid keypair."); continue; }
      } else {
        try { new PublicKey(pubkeyStr); pubkey = pubkeyStr; } catch { console.log("  Invalid pubkey."); continue; }
      }
      const c = db.addClaimer(name, pubkey, walletPath);
      if (c) console.log(`  Added: ${c.name} (${c.pubkey})`);
      else console.log("  Failed to add.");
    } else if (choice === "R") {
      const idStr = await promptUser("  Claimer ID to remove: ");
      const id = parseInt(idStr, 10);
      if (isNaN(id)) continue;
      if (db.removeClaimer(id)) console.log("  Removed.");
      else console.log("  Not found.");
    } else if (choice === "W") {
      await handleWithdrawHashish(ctx);
    }
  }
}

async function handleWithdrawHashish(ctx: MiningContext) {
  const claimers = db.getActiveClaimers();
  if (claimers.length === 0) { console.log("  No active claimers."); return; }

  console.log("\n  Select destination claimer:");
  for (const c of claimers) console.log(`    [${c.id}] ${c.name} | ${formatShort(c.pubkey)}`);

  const idStr = await promptUser("  Claimer ID: ");
  const id = parseInt(idStr, 10);
  const claimer = claimers.find((c) => c.id === id);
  if (!claimer) { console.log("  Invalid ID."); return; }

  const amtStr = await promptUser("  Amount of HASHISH tokens: ");
  const amount = parseFloat(amtStr);
  if (isNaN(amount) || amount <= 0) { console.log("  Invalid amount."); return; }

  // Token amounts - assume 9 decimals like SOL
  const mintInfo = await ctx.connection.getAccountInfo(MINT);
  if (!mintInfo) { console.log("  Mint not found."); return; }
  // Read decimals from mint account (offset 44 for Token-2022)
  const decimals = mintInfo.data[44];
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));
  const destination = new PublicKey(claimer.pubkey);

  try {
    const minerKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8"))));
    const minerWallet = new anchor.Wallet(minerKp);
    const minerProvider = new anchor.AnchorProvider(ctx.connection, minerWallet, { commitment: "confirmed" });
    const program = new Program(ctx.privacyIdl, minerProvider);

    const clientSk = x25519.utils.randomSecretKey();
    const clientPk = x25519.getPublicKey(clientSk);
    const nonce = randomBytes(16);
    const state = db.loadMinerState();

    const encAmt = encryptAmount(BigInt(rawAmount), ctx.mxePublicKey, clientSk, nonce);
    const encDest = encryptDestination(destination, ctx.mxePublicKey, clientSk, nonce);
    const encState = encryptCurrentTokenState(state.tokenBalance, state.tokenNonce, state.tokenReserved, ctx.mxePublicKey, clientSk, nonce);

    const [bufferPda] = PublicKey.findProgramAddressSync(
      [WITHDRAW_TOKEN_BUFFER_SEED, minerWallet.publicKey.toBuffer(), encAmt.slice(0, 8)], POW_PRIVACY_ID,
    );

    // Ensure destination token account exists
    const destTokenAcc = await createAssociatedTokenAccountIdempotent(
      ctx.connection, minerKp, MINT, destination, {}, ctx.tokenProgramId,
    );

    // Get team_token_account from privacyConfig
    const configData = await ctx.connection.getAccountInfo(ctx.privacyConfig);
    if (!configData) throw new Error("Privacy config not found");
    // team_token_account is stored in PrivacyConfig - read from IDL
    const privacyProgram = new Program(ctx.privacyIdl, minerProvider);
    const configAccount = await (privacyProgram.account as any).privacyConfig.fetch(ctx.privacyConfig);
    const teamTokenAccount = configAccount.teamTokenAccount as PublicKey;

    console.log("  Creating withdraw token buffer...");
    await program.methods
      .createWithdrawTokenBuffer(
        Array.from(encAmt), encDest.map((c) => Array.from(c)), encState.map((c) => Array.from(c)),
        Array.from(clientPk), new anchor.BN(deserializeLE(nonce).toString()), new anchor.BN(rawAmount),
      )
      .accounts({ creator: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, withdrawTokenBuffer: bufferPda, systemProgram: SystemProgram.programId })
      .rpc();

    console.log("  Executing withdrawal via MPC...");
    const compOffset = new anchor.BN(randomBytes(8), "hex");
    const defOffset = Buffer.from(getCompDefAccOffset("withdraw_token")).readUInt32LE();
    const compDef = getCompDefAccAddress(POW_PRIVACY_ID, defOffset);
    const compAcc = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, compOffset);

    await program.methods.withdrawTokenPrivate(compOffset)
      .accounts({
        caller: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, withdrawTokenBuffer: bufferPda,
        systemProgram: SystemProgram.programId,
        signPdaAccount: ctx.signPdaAccount,
        mxeAccount: ctx.mxeAccount, mempoolAccount: ctx.mempoolAccount,
        executingPool: ctx.executingPool, computationAccount: compAcc, compDefAccount: compDef,
        clusterAccount: ctx.clusterAccount, poolAccount: ARCIUM_FEE_POOL, clockAccount: ARCIUM_CLOCK,
        arciumProgram: ARCIUM_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc({ skipPreflight: true });

    console.log("  Waiting for MPC callback...");
    try {
      await awaitComputationFinalization(minerProvider, compOffset, POW_PRIVACY_ID, "confirmed");
    } catch { console.log("  MPC timeout - may complete in background."); return; }

    // Step 3: Execute the token transfer after MPC approval
    console.log("  Executing token transfer...");

    // Derive transfer hook accounts
    const [hookExtraAccountMetas] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), MINT.toBuffer()], TRANSFER_HOOK_PROGRAM_ID,
    );
    const [hookFeeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault"), MINT.toBuffer()], TRANSFER_HOOK_PROGRAM_ID,
    );
    const [hookPowConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("pow_config")], TRANSFER_HOOK_PROGRAM_ID,
    );

    await program.methods.executeWithdrawToken()
      .accounts({
        caller: minerWallet.publicKey, privacyConfig: ctx.privacyConfig, withdrawTokenBuffer: bufferPda,
        privacyAuthority: ctx.privacyAuthority, mint: MINT, sharedTokenVault: ctx.sharedTokenVault,
        destinationTokenAccount: destTokenAcc, teamTokenAccount,
        tokenProgram: ctx.tokenProgramId,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        extraAccountMetaList: hookExtraAccountMetas,
        hookFeeVault,
        hookPowConfig,
        powProtocolProgram: POW_PROTOCOL_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc({ skipPreflight: true });

    const s = db.loadMinerState();
    s.tokenBalance -= BigInt(rawAmount);
    s.tokenNonce += 1n;
    db.saveMinerState(s);
    console.log(`  Withdrawal successful! ${amount} HASHISH to ${claimer.name} (${formatShort(claimer.pubkey)})`);
  } catch (e: any) { console.error("  Withdrawal failed:", e?.message || e); }
}

// ── MAIN MENU ──

async function handleMenu(ctx: MiningContext) {
  menuActive = true;
  killMiningProcess();

  // Restore cursor and clear screen for menu
  if (renderer.cursorHidden) {
    process.stdout.write("\x1b[?25h");
    renderer.cursorHidden = false;
  }
  renderer.active = false;
  renderer.previousLines = [];
  // Clear terminal for clean menu display
  process.stdout.write("\x1b[2J\x1b[H");

  printMainMenu();

  while (menuActive) {
    const choice = (await promptUser("Menu > ")).toUpperCase();
    switch (choice) {
      case "1": await handleMinersMenu(ctx); printMainMenu(); break;
      case "2": await handleRelayersMenu(ctx); printMainMenu(); break;
      case "3": await handleClaimersMenu(ctx); printMainMenu(); break;
      case "S":
        console.log("\nStopping miner...");
        isMining = false;
        menuActive = false;
        break;
      case "M": case "":
        menuActive = false;
        // Clear screen for dashboard
        process.stdout.write("\x1b[2J\x1b[H");
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
        }
        break;
      default:
        console.log("Invalid choice.");
    }
  }
}

// ============================================================================
// MINING CONTEXT
// ============================================================================

interface MiningContext {
  connection: anchor.web3.Connection;
  mxePublicKey: Uint8Array;
  privacyConfig: PublicKey;
  privacyAuthority: PublicKey;
  sharedTokenVault: PublicKey;
  sharedFeeVault: PublicKey;
  signPdaAccount: PublicKey;
  mxeAccount: PublicKey;
  mempoolAccount: PublicKey;
  executingPool: PublicKey;
  clusterAccount: PublicKey;
  tokenProgramId: PublicKey;
  privacyIdl: any;
  protocolIdl: any;
  // pow-protocol PDAs
  powConfig: PublicKey;
  powOtherPool: PublicKey;
  powMintAuthority: PublicKey;
  powFeeVault: PublicKey;
  cycleGate: PublicKey;
  privacyMinerStats: PublicKey;
  mineBlockCompDef: PublicKey;
  depositTokenCompDef: PublicKey;
  addressLookupTable: AddressLookupTableAccount | null;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const dashboard = createDashboardState();
  let stopRenderer = startDashboardRenderer(dashboard);
  let activeGpu: { kill: () => void } | null = null;

  const shutdown = () => {
    activeGpu?.kill();
    stopRenderer();
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(0);
  };
  process.once("SIGINT", shutdown);

  try {
    setPhase(dashboard, "booting", `Loading for ${networkLabel}`);
    pushEvent(dashboard, `Config: ${networkLabel}`);
    renderDashboard(dashboard);

    const connection = new anchor.web3.Connection(currentRpcUrl, "confirmed");

    // Detect token program
    const mintInfo = await connection.getAccountInfo(MINT);
    if (!mintInfo) throw new Error("Mint not found");
    const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // Load IDLs
    const privacyIdl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_privacy.json", "utf-8"));
    const protocolIdl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_protocol.json", "utf-8"));

    // Arcium setup
    pushEvent(dashboard, "Initializing Arcium MPC...");
    renderDashboard(dashboard);

    const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
    let mxePublicKey: Uint8Array | null = null;

    // We need a temporary provider for MXE key fetch
    // Use first relayer or miner wallet
    const tempKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8"))));
    const tempWallet = new anchor.Wallet(tempKp);
    const tempProvider = new anchor.AnchorProvider(connection, tempWallet, { commitment: "confirmed" });
    anchor.setProvider(tempProvider);

    dashboard.minerWallet = tempKp.publicKey.toString();

    for (let i = 1; i <= 5; i++) {
      try {
        mxePublicKey = await getMXEPublicKey(tempProvider, POW_PRIVACY_ID);
        if (mxePublicKey) break;
      } catch { await sleep(1000); }
    }
    if (!mxePublicKey) throw new Error("Failed to get MXE public key");

    const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET);
    const mempoolAccount = getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET);
    const executingPool = getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET);

    pushEvent(dashboard, "Arcium MPC ready");
    renderDashboard(dashboard);

    // PDAs
    const [privacyConfig] = PublicKey.findProgramAddressSync([PRIVACY_CONFIG_SEED], POW_PRIVACY_ID);
    const [privacyAuthority] = PublicKey.findProgramAddressSync([PRIVACY_AUTHORITY_SEED, privacyConfig.toBuffer()], POW_PRIVACY_ID);
    const [sharedTokenVault] = PublicKey.findProgramAddressSync([SHARED_TOKEN_VAULT_SEED, privacyConfig.toBuffer(), MINT.toBuffer()], POW_PRIVACY_ID);
    const [sharedFeeVault] = PublicKey.findProgramAddressSync([SHARED_FEE_VAULT_SEED, privacyConfig.toBuffer()], POW_PRIVACY_ID);
    const [signPdaAccount] = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], POW_PRIVACY_ID);
    const [powConfig] = PublicKey.findProgramAddressSync([POW_CONFIG_SEED, Buffer.from([POOL_NORMAL])], POW_PROTOCOL_ID);
    const [powOtherPool] = PublicKey.findProgramAddressSync([POW_CONFIG_SEED, Buffer.from([POOL_SEEKER])], POW_PROTOCOL_ID);
    const [powMintAuthority] = PublicKey.findProgramAddressSync([POW_MINT_AUTHORITY_SEED], POW_PROTOCOL_ID);
    const [powFeeVault] = PublicKey.findProgramAddressSync([POW_FEE_VAULT_SEED], POW_PROTOCOL_ID);
    const [cycleGate] = PublicKey.findProgramAddressSync([Buffer.from("cycle_gate")], POW_PROTOCOL_ID);
    const [privacyMinerStats] = PublicKey.findProgramAddressSync(
      [POW_MINER_STATS_SEED, Buffer.from([POOL_NORMAL]), privacyAuthority.toBuffer()], POW_PROTOCOL_ID,
    );

    const mineBlockOffset = Buffer.from(getCompDefAccOffset("mine_block")).readUInt32LE();
    const mineBlockCompDef = getCompDefAccAddress(POW_PRIVACY_ID, mineBlockOffset);
    const depositTokenOffset = Buffer.from(getCompDefAccOffset("deposit_token")).readUInt32LE();
    const depositTokenCompDef = getCompDefAccAddress(POW_PRIVACY_ID, depositTokenOffset);

    // ALT
    let addressLookupTable: AddressLookupTableAccount | null = null;
    try {
      const altConfig = JSON.parse(fs.readFileSync(__dirname + "/../alt-config.json", "utf-8"));
      const altInfo = await connection.getAddressLookupTable(new PublicKey(altConfig.altAddress));
      if (altInfo.value) addressLookupTable = altInfo.value;
    } catch {}

    const ctx: MiningContext = {
      connection, mxePublicKey, privacyConfig, privacyAuthority, sharedTokenVault, sharedFeeVault,
      signPdaAccount, mxeAccount, mempoolAccount, executingPool, clusterAccount, tokenProgramId,
      privacyIdl, protocolIdl, powConfig, powOtherPool, powMintAuthority, powFeeVault, cycleGate,
      privacyMinerStats, mineBlockCompDef, depositTokenCompDef, addressLookupTable,
    };

    // Setup keyboard listener
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", async (key: string) => {
        if (key === "\u0003") shutdown();
        if ((key === "m" || key === "M") && !menuActive) {
          // Kill GPU immediately & stop dashboard
          activeGpu?.kill();
          activeGpu = null;
          stopRenderer();
          await handleMenu(ctx);
          if (isMining) {
            // Restart dashboard
            renderer.active = false;
            renderer.previousLines = [];
            if (!renderer.cursorHidden) { process.stdout.write("\x1b[?25l"); renderer.cursorHidden = true; }
            dashboard.relayerCount = db.getActiveRelayers().length;
            dashboard.claimerCount = db.getActiveClaimers().length;
            renderDashboard(dashboard);
            stopRenderer = startDashboardRenderer(dashboard);
          }
        }
      });
    }

    // Update counts
    dashboard.relayerCount = db.getActiveRelayers().length;
    dashboard.claimerCount = db.getActiveClaimers().length;

    setPhase(dashboard, "ready", "Miner ready");
    pushEvent(dashboard, `Relayers: ${dashboard.relayerCount} | Claimers: ${dashboard.claimerCount}`);
    renderDashboard(dashboard);

    // =========================================================================
    // MINING LOOP
    // =========================================================================

    while (isMining) {
      if (menuActive) { await sleep(500); continue; }

      try {
        // Pick random relayer
        const relayer = db.getRandomRelayer();
        if (!relayer) {
          setPhase(dashboard, "error", "No relayers configured! Press M to add one.");
          pushEvent(dashboard, "No relayers - add via menu [2]");
          renderDashboard(dashboard);
          await sleep(5000);
          continue;
        }

        const relayerKp = db.loadRelayerKeypair(relayer);
        if (!relayerKp) {
          pushEvent(dashboard, `Failed to load relayer: ${relayer.name}`);
          await sleep(2000);
          continue;
        }

        if (menuActive) continue;

        dashboard.relayerWallet = relayer.pubkey;
        const relayerWallet = new anchor.Wallet(relayerKp);
        const relayerProvider = new anchor.AnchorProvider(connection, relayerWallet, { commitment: "confirmed" });
        const powPrivacy = new Program(privacyIdl, relayerProvider);

        // Fetch state
        setPhase(dashboard, "syncing", "Fetching challenge");
        renderDashboard(dashboard);

        if (menuActive) continue;
        const protocolState = await readProtocolState(connection, powConfig);
        dashboard.currentState = protocolState;
        dashboard.currentNonce = null;
        pushEvent(dashboard, `Synced #${formatBigInt(protocolState.blocksMined)} | relayer: ${relayer.name}`);
        setPhase(dashboard, "mining", `Mining #${formatBigInt(protocolState.blocksMined)} on ${dashboard.backend}`);
        renderDashboard(dashboard);

        // GPU mine
        const gpu = startGpuMiner(
          protocolState.challengeHex, privacyAuthority.toBuffer().toString("hex"),
          protocolState.blocksMined, protocolState.difficulty,
          (p) => { dashboard.liveHashrate = p.liveHashrate; dashboard.liveAvgHashrate = p.avgHashrate; dashboard.liveHashesChecked = p.hashesChecked; },
        );
        activeGpu = gpu;

        const monitor = createChallengeMonitor(connection, powConfig, protocolState, challengePollIntervalMs);
        const outcome = await Promise.race([
          gpu.promise.then((r) => ({ source: "gpu" as const, result: r })),
          monitor.changed.then((s) => ({ source: "chain" as const, state: s })),
        ]);
        monitor.stop();

        if (outcome.source === "chain") {
          if (outcome.state) {
            activeGpu?.kill();
            await gpu.promise;
            activeGpu = null;
            dashboard.currentState = outcome.state;
            dashboard.staleBlocks++;
            dashboard.restartCount++;
            setPhase(dashboard, "lost", `Block moved to #${formatBigInt(outcome.state.blocksMined)}`);
            pushEvent(dashboard, `Stale - someone else mined #${formatBigInt(protocolState.blocksMined)}`);
            renderDashboard(dashboard);
          }
          continue;
        }

        activeGpu = null;
        const mResult = outcome.result;

        if (mResult.status === "stopped") { dashboard.restartCount++; continue; }
        if (mResult.status === "error") {
          dashboard.errorCount++;
          dashboard.restartCount++;
          setPhase(dashboard, "error", "GPU failed");
          pushEvent(dashboard, mResult.reason);
          renderDashboard(dashboard);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        dashboard.currentNonce = mResult.nonce;
        dashboard.lastHashrate = mResult.hashrate;
        dashboard.lastMiningTimeMs = mResult.timeMs;
        dashboard.totalHashrate += mResult.hashrate;
        dashboard.hashrateSamples++;
        pushEvent(dashboard, `Nonce ${mResult.nonce} in ${(mResult.timeMs / 1000).toFixed(2)}s @ ${mResult.hashrate.toFixed(2)} MH/s`);
        renderDashboard(dashboard);

        if (menuActive) continue;

        // Check if stale before submit
        const preSubmit = await readProtocolState(connection, powConfig);
        dashboard.currentState = preSubmit;
        if (preSubmit.blocksMined !== protocolState.blocksMined || preSubmit.challengeHex !== protocolState.challengeHex) {
          dashboard.staleBlocks++;
          dashboard.restartCount++;
          setPhase(dashboard, "lost", `Block moved before submit`);
          pushEvent(dashboard, `Stale before submit`);
          renderDashboard(dashboard);
          continue;
        }

        if (menuActive) continue;

        // =====================================================================
        // SUBMIT BLOCK
        // =====================================================================

        // Snapshot vault balance before submit to compute reward delta
        let vaultBalanceBefore = 0n;
        try {
          const vb = await connection.getTokenAccountBalance(sharedTokenVault);
          vaultBalanceBefore = BigInt(vb.value.amount);
        } catch {}

        setPhase(dashboard, "submitting", `Submitting #${formatBigInt(protocolState.blocksMined)}`);
        renderDashboard(dashboard);

        const clientSk = x25519.utils.randomSecretKey();
        const clientPk = x25519.getPublicKey(clientSk);
        const nonce = randomBytes(16);
        const minerState = db.loadMinerState();
        const encState = encryptCurrentState(
          minerState.balance, minerState.stateNonce, minerState.reserved,
          mxePublicKey, clientSk, nonce,
        );

        const mineCompOffset = new anchor.BN(randomBytes(8), "hex");
        const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, mineCompOffset);

        const method = powPrivacy.methods
          .submitBlockPrivate(
            mineCompOffset,
            new anchor.BN(mResult.nonce.toString()),
            Array.from(clientPk),
            new anchor.BN(deserializeLE(nonce).toString()),
            encState.map((c) => Array.from(c)),
          )
          .accounts({
            relayer: relayerWallet.publicKey,
            privacyConfig, privacyAuthority, sharedTokenVault, sharedFeeVault,
            powConfig, powOtherPool: ctx.powOtherPool, powMintAuthority: ctx.powMintAuthority,
            mint: MINT, privacyMinerStats: ctx.privacyMinerStats,
            powFeeCollector: ctx.powFeeVault, cycleGate: ctx.cycleGate,
            powProgram: POW_PROTOCOL_ID, tokenProgram: tokenProgramId,
            systemProgram: SystemProgram.programId, signPdaAccount,
            mxeAccount, mempoolAccount, executingPool, computationAccount,
            compDefAccount: mineBlockCompDef, clusterAccount,
            poolAccount: ARCIUM_FEE_POOL, clockAccount: ARCIUM_CLOCK,
            arciumProgram: ARCIUM_PROGRAM_ID,
          });

        const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
        const ix = await method.preInstructions([computeBudgetIx]).instruction();
        const allIx = [computeBudgetIx, ix];

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const lookupTables = addressLookupTable ? [addressLookupTable] : [];
        const msgV0 = new TransactionMessage({
          payerKey: relayerWallet.publicKey,
          recentBlockhash: blockhash,
          instructions: allIx,
        }).compileToV0Message(lookupTables);

        const vtx = new VersionedTransaction(msgV0);
        vtx.sign([relayerKp]);

        // Simulate
        const sim = await connection.simulateTransaction(vtx, { commitment: "confirmed" });
        if (sim.value.err) {
          dashboard.errorCount++;
          pushEvent(dashboard, `Sim failed: ${JSON.stringify(sim.value.err)}`);
          if (sim.value.logs) pushEvent(dashboard, truncate(sim.value.logs.slice(-3).join(" | "), 160));
          renderDashboard(dashboard);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        const txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 });
        await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");

        dashboard.lastTx = txSig;
        pushEvent(dashboard, `Block submitted: ${formatShort(txSig, 12, 8)}`);

        // Update SOL state (mine_block deducted fee)
        const s = db.loadMinerState();
        // We don't know exact fee here - MPC handles it
        s.stateNonce += 1n;
        db.saveMinerState(s);

        // Non-blocking MPC finalization for mine_block
        awaitComputationFinalization(relayerProvider, mineCompOffset, POW_PRIVACY_ID, "confirmed")
          .then(() => pushEvent(dashboard, `mine_block MPC confirmed`))
          .catch(() => pushEvent(dashboard, `mine_block MPC timeout`));

        // =====================================================================
        // DEPOSIT TOKEN (credit HASHISH reward to encrypted balance)
        // =====================================================================

        setPhase(dashboard, "depositing", "Crediting HASHISH reward...");
        renderDashboard(dashboard);

        try {
          // Compute reward as vault balance delta (after mint - before mint)
          let vaultBalanceAfter = 0n;
          try {
            const vb = await connection.getTokenAccountBalance(sharedTokenVault);
            vaultBalanceAfter = BigInt(vb.value.amount);
          } catch {}
          const rewardPerBlock = vaultBalanceAfter - vaultBalanceBefore;
          if (rewardPerBlock <= 0n) {
            pushEvent(dashboard, `Vault delta <= 0, skipping deposit_token`);
            throw new Error("No reward detected");
          }
          pushEvent(dashboard, `Reward detected: ${rewardPerBlock.toString()} raw tokens`);

          const tokenClientSk = x25519.utils.randomSecretKey();
          const tokenClientPk = x25519.getPublicKey(tokenClientSk);
          const tokenNonce = randomBytes(16);
          const currentState = db.loadMinerState();

          const encTokenAmt = encryptAmount(rewardPerBlock, mxePublicKey, tokenClientSk, tokenNonce);
          const encTokenState = encryptCurrentTokenState(
            currentState.tokenBalance, currentState.tokenNonce, currentState.tokenReserved,
            mxePublicKey, tokenClientSk, tokenNonce,
          );

          // Use miner wallet for deposit_token (not relayer)
          const minerKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8"))));
          const minerWalletAnchor = new anchor.Wallet(minerKp);
          const minerProvider = new anchor.AnchorProvider(connection, minerWalletAnchor, { commitment: "confirmed" });
          const minerProgram = new Program(privacyIdl, minerProvider);

          const [depositTokenBuffer] = PublicKey.findProgramAddressSync(
            [DEPOSIT_TOKEN_BUFFER_SEED, minerKp.publicKey.toBuffer(), encTokenAmt.slice(0, 8)], POW_PRIVACY_ID,
          );

          await minerProgram.methods
            .createDepositTokenBuffer(
              Array.from(encTokenAmt), encTokenState.map((c) => Array.from(c)),
              Array.from(tokenClientPk), new anchor.BN(deserializeLE(tokenNonce).toString()),
              new anchor.BN(rewardPerBlock.toString()),
            )
            .accounts({ depositor: minerKp.publicKey, privacyConfig, depositTokenBuffer, systemProgram: SystemProgram.programId })
            .rpc();

          const tokenCompOffset = new anchor.BN(randomBytes(8), "hex");
          const tokenCompAcc = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, tokenCompOffset);

          await minerProgram.methods.depositTokenPrivate(tokenCompOffset)
            .accounts({
              depositor: minerKp.publicKey, privacyConfig, depositTokenBuffer,
              owner: minerKp.publicKey, systemProgram: SystemProgram.programId,
              signPdaAccount, mxeAccount, mempoolAccount, executingPool,
              computationAccount: tokenCompAcc, compDefAccount: depositTokenCompDef,
              clusterAccount, poolAccount: ARCIUM_FEE_POOL, clockAccount: ARCIUM_CLOCK,
              arciumProgram: ARCIUM_PROGRAM_ID,
            })
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
            .rpc({ skipPreflight: true });

          // Non-blocking MPC finalization for deposit_token
          awaitComputationFinalization(minerProvider, tokenCompOffset, POW_PRIVACY_ID, "confirmed")
            .then(() => {
              const st = db.loadMinerState();
              st.tokenBalance += rewardPerBlock;
              st.tokenNonce += 1n;
              db.saveMinerState(st);
              pushEvent(dashboard, `HASHISH credited: +${rewardPerBlock.toString()} tokens`);
            })
            .catch(() => pushEvent(dashboard, `deposit_token MPC timeout`));

        } catch (dtErr: any) {
          pushEvent(dashboard, `deposit_token failed: ${truncate(dtErr?.message || "", 80)}`);
        }

        // Wait for state advance
        const advancedState = (await waitForStateAdvance(connection, powConfig, protocolState, 12_000))
          ?? (await readProtocolState(connection, powConfig));
        dashboard.currentState = advancedState;
        dashboard.blocksWon++;
        setPhase(dashboard, "won", `Block #${formatBigInt(protocolState.blocksMined)} accepted`);
        pushEvent(dashboard, `Won #${formatBigInt(protocolState.blocksMined)}`);
        renderDashboard(dashboard);
        await sleep(POST_WIN_PAUSE_MS);

      } catch (err: any) {
        dashboard.errorCount++;
        dashboard.restartCount++;
        setPhase(dashboard, "error", "Error, retrying");
        pushEvent(dashboard, `Error: ${truncate(err?.message ?? String(err), 80)}`);
        if (err?.logs) pushEvent(dashboard, truncate(err.logs.slice(-3).join(" | "), 160));
        renderDashboard(dashboard);
        await sleep(RETRY_DELAY_MS);
      }
    }
  } finally {
    stopRenderer();
  }

  console.log("\nMiner stopped.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
