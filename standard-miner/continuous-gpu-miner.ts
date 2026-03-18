#!/usr/bin/env ts-node
/**
 * Continuous GPU Miner - PoW Protocol
 *
 * Surveille le challenge on-chain, mine en continu via le binaire GPU Rust,
 * distingue les blocs gagnés des blocs perdus, et affiche un dashboard terminal.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import { spawn } from "child_process";
import fs from "fs";
import readline from "readline";

// Config - utilise devnet par défaut, ou localhost si --local
const useLocal = process.argv.includes("--local");
const configPath = useLocal
  ? __dirname + "/../miner-config.json"
  : __dirname + "/../miner-config-devnet.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const networkLabel = useLocal ? "localhost" : "devnet";
const gpuBackend = String(config.gpu_backend ?? process.env.POW_GPU_BACKEND ?? "cuda");
const configuredChallengePollIntervalMs = Number(config.challenge_poll_interval_ms ?? 1500);
const challengePollIntervalMs = Number.isFinite(configuredChallengePollIntervalMs)
  ? Math.max(500, configuredChallengePollIntervalMs)
  : 1500;
const configuredGpuDevice = Number(config.gpu_device ?? process.env.POW_GPU_DEVICE ?? 0);
const gpuDevice = Number.isFinite(configuredGpuDevice) ? Math.max(0, Math.floor(configuredGpuDevice)) : 0;
const configuredCudaThreadsPerBlock = Number(
  config.cuda_threads_per_block ?? process.env.POW_CUDA_THREADS_PER_BLOCK,
);
const cudaThreadsPerBlock =
  Number.isFinite(configuredCudaThreadsPerBlock) && configuredCudaThreadsPerBlock > 0
    ? Math.floor(configuredCudaThreadsPerBlock)
    : null;
const configuredCudaNumBlocks = Number(config.cuda_num_blocks ?? process.env.POW_CUDA_NUM_BLOCKS);
const cudaNumBlocks =
  Number.isFinite(configuredCudaNumBlocks) && configuredCudaNumBlocks > 0
    ? Math.floor(configuredCudaNumBlocks)
    : null;

const POW_PROTOCOL_ID = new PublicKey(config.program_id);
const MINT = new PublicKey(config.mint);

// Seeds
const POW_CONFIG_SEED = Buffer.from("pow_config");
const FEE_VAULT_SEED = Buffer.from("fee_vault");
const MINER_STATS_SEED = Buffer.from("miner_stats");
const MINT_AUTHORITY_SEED = Buffer.from("pow_mint_auth");

// Pool IDs
const POOL_NORMAL = 0;
const POOL_SEEKER = 1;

const DASHBOARD_MIN_WIDTH = 76;
const DASHBOARD_MAX_WIDTH = 104;
const DASHBOARD_EVENT_LINES = 6;
const POST_WIN_PAUSE_MS = 600;
const RETRY_DELAY_MS = 5000;

type ProtocolState = {
  difficulty: bigint;
  blocksMined: bigint;
  challenge: Buffer;
  challengeHex: string;
};

type GpuMineResult =
  | {
      status: "success";
      nonce: bigint;
      hashrate: number;
      timeMs: number;
    }
  | {
      status: "stopped";
    }
  | {
      status: "error";
      reason: string;
      output?: string;
    };

type GpuProgress = {
  hashesChecked: bigint;
  liveHashrate: number;
  avgHashrate: number;
};

type MinerPhase =
  | "booting"
  | "syncing"
  | "ready"
  | "mining"
  | "submitting"
  | "won"
  | "lost"
  | "error";

type DashboardState = {
  network: string;
  backend: string;
  wallet: string;
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
  events: string[];
};

type DashboardRendererState = {
  previousLines: string[];
  active: boolean;
  cursorHidden: boolean;
};

const dashboardRenderer: DashboardRendererState = {
  previousLines: [],
  active: false,
  cursorHidden: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatBigInt(value: bigint): string {
  return value.toLocaleString("en-US");
}

function formatHashrate(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(2)} MH/s`;
}

function formatShortAddress(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }

  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatChallenge(challengeHex: string): string {
  return `${challengeHex.slice(0, 20)}...${challengeHex.slice(-8)}`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function createDashboardState(): DashboardState {
  return {
    network: networkLabel,
    backend: gpuBackend.toUpperCase(),
    wallet: "-",
    rpcUrl: config.rpc_url,
    phase: "booting",
    phaseDetail: `Loading config: ${configPath}`,
    phaseStartedAt: Date.now(),
    sessionStartedAt: Date.now(),
    spinnerIndex: 0,
    currentState: null,
    currentNonce: null,
    currentMiningStartedAt: null,
    blocksWon: 0,
    staleBlocks: 0,
    restartCount: 0,
    errorCount: 0,
    liveHashrate: null,
    liveAvgHashrate: null,
    liveHashesChecked: null,
    lastHashrate: null,
    totalHashrate: 0,
    hashrateSamples: 0,
    lastMiningTimeMs: null,
    lastTx: null,
    events: [],
  };
}

function setPhase(dashboard: DashboardState, phase: MinerPhase, detail: string) {
  dashboard.phase = phase;
  dashboard.phaseDetail = detail;
  dashboard.phaseStartedAt = Date.now();

  if (phase === "mining") {
    dashboard.currentMiningStartedAt = Date.now();
  } else {
    dashboard.currentMiningStartedAt = null;
    dashboard.liveHashrate = null;
    dashboard.liveAvgHashrate = null;
    dashboard.liveHashesChecked = null;
  }
}

function pushEvent(dashboard: DashboardState, message: string) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  dashboard.events = [`${time}  ${message}`, ...dashboard.events].slice(0, DASHBOARD_EVENT_LINES);
}

function dashboardWidth(): number {
  if (!process.stdout.isTTY) {
    return 88;
  }

  return Math.min(
    DASHBOARD_MAX_WIDTH,
    Math.max(DASHBOARD_MIN_WIDTH, process.stdout.columns ?? DASHBOARD_MIN_WIDTH),
  );
}

function boxLine(content: string, width: number): string {
  return `│ ${truncateText(content, width - 4).padEnd(width - 4, " ")} │`;
}

function doubleColumn(left: string, right: string, width: number): string {
  const innerWidth = width - 4;
  const midpoint = Math.floor(innerWidth / 2);
  const leftWidth = midpoint - 1;
  const rightWidth = innerWidth - leftWidth - 1;

  return `│ ${truncateText(left, leftWidth).padEnd(leftWidth, " ")} ${truncateText(right, rightWidth).padEnd(rightWidth, " ")} │`;
}

function buildDashboardLines(dashboard: DashboardState): string[] {
  if (!process.stdout.isTTY) {
    return [];
  }

  const width = dashboardWidth();
  const spinnerFrames = ["-", "\\", "|", "/"];
  dashboard.spinnerIndex = (dashboard.spinnerIndex + 1) % spinnerFrames.length;
  const spinner = dashboard.phase === "mining" ? spinnerFrames[dashboard.spinnerIndex] : " ";
  const currentState = dashboard.currentState;
  const averageHashrate =
    dashboard.hashrateSamples > 0 ? dashboard.totalHashrate / dashboard.hashrateSamples : null;
  const uptime = formatDuration(Date.now() - dashboard.sessionStartedAt);
  const phaseAge = formatDuration(Date.now() - dashboard.phaseStartedAt);
  const miningElapsed =
    dashboard.currentMiningStartedAt === null
      ? "-"
      : formatDuration(Date.now() - dashboard.currentMiningStartedAt);
  const title = " CONTINUOUS GPU MINER ";
  const topRule = "─".repeat(Math.max(0, width - title.length - 2));
  const txLabel = dashboard.lastTx ? formatShortAddress(dashboard.lastTx, 10, 8) : "-";
  const nonceLabel = dashboard.currentNonce === null ? "-" : dashboard.currentNonce.toString();
  const lastRoundLabel =
    dashboard.lastMiningTimeMs === null ? "-" : `${(dashboard.lastMiningTimeMs / 1000).toFixed(2)}s`;
  const liveHashesLabel =
    dashboard.liveHashesChecked === null ? "-" : formatBigInt(dashboard.liveHashesChecked);
  const challengeLabel = currentState ? formatChallenge(currentState.challengeHex) : "-";
  const blockLabel = currentState ? formatBigInt(currentState.blocksMined) : "-";
  const difficultyLabel = currentState ? formatBigInt(currentState.difficulty) : "-";
  const rpcLabel = formatShortAddress(dashboard.rpcUrl, 26, 10);

  const lines = [
    `┌${title}${topRule}┐`,
    boxLine(`${spinner} ${dashboard.phase.toUpperCase()}  ${dashboard.phaseDetail}`, width),
    doubleColumn(`Phase for : ${phaseAge}`, `Uptime : ${uptime}`, width),
    doubleColumn(`Network   : ${dashboard.network}`, `Backend : ${dashboard.backend}`, width),
    doubleColumn(`Miner     : ${formatShortAddress(dashboard.wallet)}`, `RPC : ${rpcLabel}`, width),
    doubleColumn(`Block     : ${blockLabel}`, `Difficulty : ${difficultyLabel}`, width),
    boxLine(`Challenge  : ${challengeLabel}`, width),
    doubleColumn(`Mining for: ${miningElapsed}`, `Live : ${formatHashrate(dashboard.liveHashrate)}`, width),
    doubleColumn(`Checked   : ${liveHashesLabel}`, `Live avg : ${formatHashrate(dashboard.liveAvgHashrate)}`, width),
    doubleColumn(`Last nonce: ${nonceLabel}`, `Last tx : ${txLabel}`, width),
    doubleColumn(`Last round: ${lastRoundLabel}`, `GPU dev : ${gpuDevice}`, width),
    doubleColumn(
      `Session   : wins ${dashboard.blocksWon} | stale ${dashboard.staleBlocks}`,
      `Errors : ${dashboard.errorCount} | restarts : ${dashboard.restartCount}`,
      width,
    ),
    doubleColumn(
      `Hashrate  : last ${formatHashrate(dashboard.lastHashrate)}`,
      `avg ${formatHashrate(averageHashrate)}`,
      width,
    ),
    `├${"─".repeat(width - 2)}┤`,
    boxLine("Recent events", width),
  ];

  const events = dashboard.events.length > 0 ? dashboard.events : ["No events yet."];
  for (let i = 0; i < DASHBOARD_EVENT_LINES; i++) {
    lines.push(boxLine(events[i] ?? "", width));
  }
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines;
}

function renderDashboard(dashboard: DashboardState) {
  if (!process.stdout.isTTY) {
    return;
  }

  const lines = buildDashboardLines(dashboard);
  if (lines.length === 0) {
    return;
  }

  if (!dashboardRenderer.active) {
    if (!dashboardRenderer.cursorHidden) {
      process.stdout.write("\x1b[?25l");
      dashboardRenderer.cursorHidden = true;
    }

    process.stdout.write(`${lines.join("\n")}\n`);
    dashboardRenderer.previousLines = lines;
    dashboardRenderer.active = true;
    return;
  }

  readline.moveCursor(process.stdout, 0, -dashboardRenderer.previousLines.length);

  for (let i = 0; i < lines.length; i++) {
    readline.cursorTo(process.stdout, 0);

    if (dashboardRenderer.previousLines[i] !== lines[i]) {
      readline.clearLine(process.stdout, 0);
      process.stdout.write(lines[i]);
    }

    if (i < lines.length - 1) {
      readline.moveCursor(process.stdout, 0, 1);
    }
  }

  readline.cursorTo(process.stdout, 0);
  process.stdout.write("\n");
  dashboardRenderer.previousLines = lines;
}

function startDashboardRenderer(dashboard: DashboardState): () => void {
  if (!process.stdout.isTTY) {
    return () => undefined;
  }

  renderDashboard(dashboard);

  const timer = setInterval(() => {
    renderDashboard(dashboard);
  }, 1000);

  return () => {
    clearInterval(timer);
    if (dashboardRenderer.cursorHidden) {
      process.stdout.write("\x1b[?25h");
      dashboardRenderer.cursorHidden = false;
    }
    dashboardRenderer.active = false;
    dashboardRenderer.previousLines = [];
  };
}

async function readProtocolState(
  connection: anchor.web3.Connection,
  powConfig: PublicKey,
): Promise<ProtocolState> {
  const accountInfo = await connection.getAccountInfo(powConfig);
  if (!accountInfo) {
    throw new Error("PoW config account not found");
  }

  const data = accountInfo.data;
  const difficultyLow = data.readBigUInt64LE(72);
  const difficultyHigh = data.readBigUInt64LE(80);
  const difficulty = BigInt(difficultyLow) | (BigInt(difficultyHigh) << 64n);
  const blocksMined = data.readBigUInt64LE(96);
  const challenge = Buffer.from(data.slice(112, 144));

  return {
    difficulty,
    blocksMined,
    challenge,
    challengeHex: challenge.toString("hex"),
  };
}

function startGpuMiner(
  challengeHex: string,
  minerPubkeyHex: string,
  blockNumber: bigint,
  difficulty: bigint,
  onProgress?: (progress: GpuProgress) => void,
): {
  promise: Promise<GpuMineResult>;
  kill: () => void;
} {
  const minerBinary = __dirname + "/../gpu-miner/target/release/miner";
  if (!fs.existsSync(minerBinary)) {
    return {
      promise: Promise.resolve({
        status: "error",
        reason: `GPU miner binary not found at ${minerBinary}. Build it first with cargo build --release.`,
      }),
      kill: () => undefined,
    };
  }

  const isWSL = fs.existsSync("/usr/lib/wsl/lib");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RUST_LOG: "info",
  };

  if (isWSL) {
    env.LD_LIBRARY_PATH = "/usr/lib/wsl/lib";
  }

  const args = [
    "--benchmark",
    "--backend",
    gpuBackend,
    "--device",
    String(gpuDevice),
    "--difficulty",
    difficulty.toString(),
    "--challenge",
    challengeHex,
    "--block-number",
    blockNumber.toString(),
    "--miner-pubkey",
    minerPubkeyHex,
  ];

  if (gpuBackend === "cuda") {
    if (cudaThreadsPerBlock !== null) {
      args.push("--cuda-threads-per-block", String(cudaThreadsPerBlock));
    }
    if (cudaNumBlocks !== null) {
      args.push("--cuda-num-blocks", String(cudaNumBlocks));
    }
  }

  const child = spawn(minerBinary, args, { env });
  let killed = false;
  let output = "";
  let lineBuffer = "";

  const parseProgressLine = (line: string) => {
    const progressMatch = line.match(
      /Progress:\s+(\d+)\s+hashes\s+\|\s+Live:\s+([\d.]+)\s+MH\/s\s+\|\s+Avg:\s+([\d.]+)\s+MH\/s/,
    );

    if (!progressMatch) {
      return;
    }

    onProgress?.({
      hashesChecked: BigInt(progressMatch[1]),
      liveHashrate: parseFloat(progressMatch[2]),
      avgHashrate: parseFloat(progressMatch[3]),
    });
  };

  const consumeChunk = (chunk: string) => {
    output += chunk;
    lineBuffer += chunk;

    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      parseProgressLine(line);
    }
  };

  child.stdout.on("data", (data: Buffer) => {
    consumeChunk(data.toString());
  });

  child.stderr.on("data", (data: Buffer) => {
    consumeChunk(data.toString());
  });

  const promise = new Promise<GpuMineResult>((resolve) => {
    child.on("close", (code) => {
      if (lineBuffer.trim().length > 0) {
        parseProgressLine(lineBuffer);
      }

      if (killed) {
        resolve({ status: "stopped" });
        return;
      }

      if (code !== 0) {
        resolve({
          status: "error",
          reason: `GPU miner exited with code ${code ?? "unknown"}`,
          output,
        });
        return;
      }

      const nonceMatch = output.match(/Nonce found:\s+(\d+)/);
      const timeMatch = output.match(/Time:\s+([\d.]+)(µs|ms|s)/);
      const hashrateMatch = output.match(/Hashrate:\s+([\d.]+)\s+MH\/s/);

      if (!nonceMatch || !timeMatch || !hashrateMatch) {
        resolve({
          status: "error",
          reason: "Failed to parse GPU miner output",
          output,
        });
        return;
      }

      const timeValue = parseFloat(timeMatch[1]);
      const unit = timeMatch[2];
      const timeMs =
        unit === "s"
          ? timeValue * 1000
          : unit === "ms"
            ? timeValue
            : timeValue / 1000;

      resolve({
        status: "success",
        nonce: BigInt(nonceMatch[1]),
        hashrate: parseFloat(hashrateMatch[1]),
        timeMs,
      });
    });

    child.on("error", (err) => {
      resolve({
        status: "error",
        reason: `GPU mining error: ${err.message}`,
      });
    });
  });

  return {
    promise,
    kill: () => {
      if (killed) {
        return;
      }

      killed = true;
      child.kill("SIGTERM");
    },
  };
}

function createChallengeMonitor(
  connection: anchor.web3.Connection,
  powConfig: PublicKey,
  baseline: ProtocolState,
  pollIntervalMs: number,
): {
  changed: Promise<ProtocolState | null>;
  stop: () => void;
} {
  let stopped = false;
  let settled = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveChanged: (value: ProtocolState | null) => void = () => undefined;

  const settle = (value: ProtocolState | null) => {
    if (settled) {
      return;
    }

    settled = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    resolveChanged(value);
  };

  const changed = new Promise<ProtocolState | null>((resolve) => {
    resolveChanged = resolve;
  });

  const poll = async () => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;
    try {
      const freshState = await readProtocolState(connection, powConfig);
      if (
        freshState.blocksMined !== baseline.blocksMined ||
        freshState.challengeHex !== baseline.challengeHex
      ) {
        stopped = true;
        settle(freshState);
      }
    } catch {
      // Ignore transient RPC errors while mining.
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void poll();
  }, pollIntervalMs);
  void poll();

  return {
    changed,
    stop: () => {
      if (stopped) {
        settle(null);
        return;
      }

      stopped = true;
      settle(null);
    },
  };
}

async function waitForStateAdvance(
  connection: anchor.web3.Connection,
  powConfig: PublicKey,
  baseline: ProtocolState,
  timeoutMs: number,
): Promise<ProtocolState | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const freshState = await readProtocolState(connection, powConfig);
      if (
        freshState.blocksMined !== baseline.blocksMined ||
        freshState.challengeHex !== baseline.challengeHex
      ) {
        return freshState;
      }
    } catch {
      // Ignore transient RPC errors and keep waiting.
    }

    await sleep(800);
  }

  return null;
}

function summarizeOutput(output?: string): string | null {
  if (!output) {
    return null;
  }

  const compact = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");

  return compact.length > 0 ? truncateText(compact, 160) : null;
}

async function main() {
  const dashboard = createDashboardState();
  const stopDashboardRenderer = startDashboardRenderer(dashboard);
  let activeGpu: { kill: () => void } | null = null;

  const shutdown = () => {
    activeGpu?.kill();
    stopDashboardRenderer();
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    process.exit(0);
  };

  process.once("SIGINT", shutdown);

  try {
    setPhase(dashboard, "booting", `Loading miner for ${networkLabel}`);
    pushEvent(dashboard, `Using config: ${networkLabel}`);
    renderDashboard(dashboard);

    // Connection
    const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");

    // Wallet
    const walletKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(config.wallet_path, "utf-8"))),
    );
    const wallet = new anchor.Wallet(walletKeypair);
    dashboard.wallet = wallet.publicKey.toString();

    // Load program
    const idlPath = __dirname + "/../target/idl/pow_protocol.json";
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const program = new Program(idl, provider);

    // PDAs (normal pool = pool_id 0)
    const [powConfig] = PublicKey.findProgramAddressSync(
      [POW_CONFIG_SEED, Buffer.from([POOL_NORMAL])],
      POW_PROTOCOL_ID,
    );

    const [otherPool] = PublicKey.findProgramAddressSync(
      [POW_CONFIG_SEED, Buffer.from([POOL_SEEKER])],
      POW_PROTOCOL_ID,
    );

    const [mintAuthority] = PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED], POW_PROTOCOL_ID);

    const [feeVault] = PublicKey.findProgramAddressSync([FEE_VAULT_SEED], POW_PROTOCOL_ID);

    const [minerStats] = PublicKey.findProgramAddressSync(
      [MINER_STATS_SEED, Buffer.from([POOL_NORMAL]), wallet.publicKey.toBuffer()],
      POW_PROTOCOL_ID,
    );

    const minerTokenAccount = getAssociatedTokenAddressSync(
      MINT,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    setPhase(dashboard, "ready", "Ensuring reward token account exists");
    pushEvent(dashboard, "Creating token account if needed");
    renderDashboard(dashboard);

    await createAssociatedTokenAccountIdempotent(
      connection,
      wallet.payer,
      MINT,
      wallet.publicKey,
      {},
      TOKEN_2022_PROGRAM_ID,
    );

    pushEvent(dashboard, "Reward token account ready");
    if (gpuBackend === "cuda" && (cudaThreadsPerBlock !== null || cudaNumBlocks !== null)) {
      pushEvent(
        dashboard,
        `CUDA tuning enabled: threads/block ${cudaThreadsPerBlock ?? 256}, blocks ${cudaNumBlocks ?? 1024}`,
      );
    }
    renderDashboard(dashboard);

    while (true) {
      try {
        setPhase(dashboard, "syncing", "Fetching on-chain challenge");
        renderDashboard(dashboard);

        const protocolState = await readProtocolState(connection, powConfig);
        dashboard.currentState = protocolState;
        dashboard.currentNonce = null;
        pushEvent(
          dashboard,
          `Synced block #${formatBigInt(protocolState.blocksMined)} | challenge ${formatChallenge(protocolState.challengeHex)}`,
        );
        setPhase(
          dashboard,
          "mining",
          `Mining block #${formatBigInt(protocolState.blocksMined)} on ${dashboard.backend}`,
        );
        renderDashboard(dashboard);

        const gpu = startGpuMiner(
          protocolState.challengeHex,
          wallet.publicKey.toBuffer().toString("hex"),
          protocolState.blocksMined,
          protocolState.difficulty,
          (progress) => {
            dashboard.liveHashrate = progress.liveHashrate;
            dashboard.liveAvgHashrate = progress.avgHashrate;
            dashboard.liveHashesChecked = progress.hashesChecked;
          },
        );
        activeGpu = gpu;

        const challengeMonitor = createChallengeMonitor(
          connection,
          powConfig,
          protocolState,
          challengePollIntervalMs,
        );

        const outcome = await Promise.race([
          gpu.promise.then((result) => ({ source: "gpu" as const, result })),
          challengeMonitor.changed.then((state) => ({ source: "chain" as const, state })),
        ]);

        challengeMonitor.stop();

        if (outcome.source === "chain") {
          if (outcome.state) {
            activeGpu?.kill();
            await gpu.promise;
            activeGpu = null;
            dashboard.currentState = outcome.state;
            dashboard.staleBlocks++;
            dashboard.restartCount++;
            setPhase(
              dashboard,
              "lost",
              `Challenge changed to block #${formatBigInt(outcome.state.blocksMined)}`,
            );
            pushEvent(
              dashboard,
              `New challenge detected on-chain. Another miner likely solved block #${formatBigInt(protocolState.blocksMined)} first.`,
            );
            renderDashboard(dashboard);
          }
          continue;
        }

        activeGpu = null;

        const miningResult = outcome.result;
        if (miningResult.status === "stopped") {
          dashboard.restartCount++;
          setPhase(dashboard, "syncing", "GPU mining stopped, resyncing challenge");
          pushEvent(dashboard, "GPU miner stopped before finishing, resyncing");
          renderDashboard(dashboard);
          continue;
        }

        if (miningResult.status === "error") {
          dashboard.errorCount++;
          dashboard.restartCount++;
          setPhase(dashboard, "error", "GPU miner failed");
          pushEvent(dashboard, miningResult.reason);

          const outputSummary = summarizeOutput(miningResult.output);
          if (outputSummary) {
            pushEvent(dashboard, outputSummary);
          }

          renderDashboard(dashboard);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        dashboard.currentNonce = miningResult.nonce;
        dashboard.lastHashrate = miningResult.hashrate;
        dashboard.lastMiningTimeMs = miningResult.timeMs;
        dashboard.totalHashrate += miningResult.hashrate;
        dashboard.hashrateSamples++;
        pushEvent(
          dashboard,
          `Nonce ${miningResult.nonce.toString()} found in ${(miningResult.timeMs / 1000).toFixed(2)}s at ${miningResult.hashrate.toFixed(2)} MH/s`,
        );
        renderDashboard(dashboard);

        const finalStateBeforeSubmit = await readProtocolState(connection, powConfig);
        dashboard.currentState = finalStateBeforeSubmit;
        if (
          finalStateBeforeSubmit.blocksMined !== protocolState.blocksMined ||
          finalStateBeforeSubmit.challengeHex !== protocolState.challengeHex
        ) {
          dashboard.staleBlocks++;
          dashboard.restartCount++;
          setPhase(
            dashboard,
            "lost",
            `Block moved to #${formatBigInt(finalStateBeforeSubmit.blocksMined)} before submit`,
          );
          pushEvent(
            dashboard,
            `Challenge changed just before submit. Someone else mined block #${formatBigInt(protocolState.blocksMined)}.`,
          );
          renderDashboard(dashboard);
          continue;
        }

        setPhase(
          dashboard,
          "submitting",
          `Submitting nonce for block #${formatBigInt(protocolState.blocksMined)}`,
        );
        renderDashboard(dashboard);

        let tx: string;
        try {
          const nonceBn = new anchor.BN(miningResult.nonce.toString());
          tx = await program.methods
            .submitProof(nonceBn)
            .accounts({
              miner: wallet.publicKey,
              powConfig,
              otherPool,
              mintAuthority,
              mint: MINT,
              minerTokenAccount,
              minerStats,
              feeCollector: feeVault,
              attestation: null,
              tokenProgram: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

          dashboard.lastTx = tx;
          pushEvent(dashboard, `Proof sent: ${formatShortAddress(tx, 12, 8)}`);
          renderDashboard(dashboard);

          await connection.confirmTransaction(tx, "confirmed");
        } catch (err: any) {
          dashboard.errorCount++;
          dashboard.restartCount++;

          try {
            dashboard.currentState = await readProtocolState(connection, powConfig);
          } catch {
            // Ignore refresh errors inside the submit error path.
          }

          setPhase(dashboard, "error", "Submit failed, resyncing");
          pushEvent(dashboard, `Submit failed: ${err?.message ?? String(err)}`);

          if (Array.isArray(err?.logs) && err.logs.length > 0) {
            pushEvent(dashboard, truncateText(err.logs.slice(0, 3).join(" | "), 160));
          }

          renderDashboard(dashboard);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        const advancedState =
          (await waitForStateAdvance(connection, powConfig, protocolState, 12_000)) ??
          (await readProtocolState(connection, powConfig));
        dashboard.currentState = advancedState;
        dashboard.blocksWon++;
        setPhase(
          dashboard,
          "won",
          `Block #${formatBigInt(protocolState.blocksMined)} accepted on-chain`,
        );
        pushEvent(
          dashboard,
          `Block accepted. We mined block #${formatBigInt(protocolState.blocksMined)} and chain moved to #${formatBigInt(advancedState.blocksMined)}.`,
        );
        renderDashboard(dashboard);
        await sleep(POST_WIN_PAUSE_MS);
      } catch (err: any) {
        dashboard.errorCount++;
        dashboard.restartCount++;
        setPhase(dashboard, "error", "Unexpected error, retrying");
        pushEvent(dashboard, `Unexpected error: ${err?.message ?? String(err)}`);

        if (Array.isArray(err?.logs) && err.logs.length > 0) {
          pushEvent(dashboard, truncateText(err.logs.slice(0, 3).join(" | "), 160));
        }

        renderDashboard(dashboard);
        await sleep(RETRY_DELAY_MS);
      }
    }
  } finally {
    stopDashboardRenderer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
