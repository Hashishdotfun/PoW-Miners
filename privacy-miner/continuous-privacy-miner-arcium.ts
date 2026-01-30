#!/usr/bin/env ts-node
/**
 * Continuous Privacy Miner with Arcium MPC Integration
 *
 * Interactive miner with menu accessible at any time:
 * - [D] Deposit SOL to encrypted balance
 * - [W] Withdraw SOL from encrypted balance
 * - [L] List pending/unclaimed rewards
 * - [S] Stop mining
 * - [R] Change relayer address
 * - [C] Change claim address
 *
 * Flow with Arcium:
 * 1. Mine with GPU (same as regular miner)
 * 2. Generate random secret + destination wallet
 * 3. Encrypt destination with MXE x25519 key (RescueCipher)
 * 4. Submit via pow-privacy -> queues store_claim MPC computation
 * 5. Arcium MPC stores encrypted claim data
 * 6. Claim rewards -> queues verify_and_claim MPC computation
 * 7. MPC verifies secret, decrypts destination, transfers tokens
 *
 * Destinations are NEVER visible on-chain - only MPC can decrypt them.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent
} from "@solana/spl-token";
import {
  getMXEAccAddress,
  getMXEPublicKey,
  getCompDefAccAddress,
  getCompDefAccOffset,
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
import { spawn, ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from "fs";
import * as readline from 'readline';
import { printBalanceStatus } from "./check-miner-balance";
import * as claimsDb from "./claims-db";

// Track the current mining process so we can kill it when menu opens
let currentMiningProcess: ChildProcess | null = null;

// Config
const useLocal = process.argv.includes("--local");
const configPath = useLocal
  ? __dirname + "/../miner-config.json"
  : __dirname + "/../miner-config-devnet.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// Program IDs (pow-protocol is derived from IDL address to avoid stale config)
const POW_PRIVACY_ID = new PublicKey("EnchaSHvRoShUp6zrF2awSeQGVYjGFZfjpkdoi2nKPBk");
const TRANSFER_HOOK_PROGRAM_ID = new PublicKey("4Q1SrMmhDhtkgsQiCutmkJxYJ1TWYTm9oh5R3h9tENcZ");
const POW_PROTOCOL_ID = new PublicKey("PoWgG9zPrzF2vFUQRTyU4L1aNMZmbsemxJgwhycjtS4");
const MINT = new PublicKey(config.mint);

// Arcium cluster offset (fallback to devnet v0.6.3 if env not set)
const DEFAULT_CLUSTER_OFFSET = 456;
const ARCIUM_CLUSTER_OFFSET_FROM_ENV =
  process.env.ARCIUM_CLUSTER_OFFSET !== undefined &&
  Number.isFinite(Number(process.env.ARCIUM_CLUSTER_OFFSET));
const ARCIUM_CLUSTER_OFFSET = ARCIUM_CLUSTER_OFFSET_FROM_ENV
  ? Number(process.env.ARCIUM_CLUSTER_OFFSET)
  : DEFAULT_CLUSTER_OFFSET;

// Arcium program and global accounts (from SDK)
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const ARCIUM_FEE_POOL = getFeePoolAccAddress();
const ARCIUM_CLOCK = getClockAccAddress();

// Seeds for pow-protocol
const POW_CONFIG_SEED = Buffer.from("pow_config");
const POW_FEE_VAULT_SEED = Buffer.from("fee_vault");
const POW_MINER_STATS_SEED = Buffer.from("miner_stats");

// Seeds for transfer hook
const HOOK_EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");
const HOOK_FEE_VAULT_SEED = Buffer.from("fee_vault");

// Seeds for pow-privacy
const PRIVACY_CONFIG_SEED = Buffer.from("privacy_config");
const PRIVACY_AUTHORITY_SEED = Buffer.from("privacy_authority");
const SHARED_TOKEN_VAULT_SEED = Buffer.from("shared_token_vault");
const SHARED_FEE_VAULT_SEED = Buffer.from("shared_fee_vault");
const CLAIM_SEED = Buffer.from("claim");
const CLAIM_BUFFER_SEED = Buffer.from("claim_buffer");
const CLAIM_REQUEST_BUFFER_SEED = Buffer.from("claim_request_buffer");
const DEPOSIT_BUFFER_SEED = Buffer.from("deposit_buffer");
const WITHDRAW_BUFFER_SEED = Buffer.from("withdraw_buffer");

// Arcium sign PDA seed
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

// ============================================================================
// GLOBAL STATE
// ============================================================================

// Store pending claims to process later
interface PendingClaim {
  claimId: number;
  secret: Buffer;
  destinationWallet: Keypair;
  destinationPubkey?: string; // For user-defined destinations (may not have secret key)
  clientPrivateKey: Uint8Array;
  computationOffset: anchor.BN;
  amount?: number;
  createdAt: number;
}

const pendingClaims: PendingClaim[] = [];

// Mining control
let isMining = true;
let menuActive = false;

// Configurable addresses (loaded from DB if available, otherwise from config)
let minerWalletPath = claimsDb.getMinerWalletPath() ?? config.wallet_path;
let relayerWalletPath = claimsDb.getRelayerWalletPath() ?? config.relayer_wallet_path ?? config.wallet_path;
let currentRpcUrl = claimsDb.getRpcUrl() ?? config.rpc_url;

// Load default claim wallet from DB (path to keypair file)
const savedClaimWalletPath = claimsDb.getClaimDestination();
let defaultClaimWalletPath: string | null = savedClaimWalletPath ?? null;

// Global claim context (set in main(), used by handleClaimRewards)
let claimContext: {
  provider: anchor.AnchorProvider;
  program: Program;
  connection: anchor.web3.Connection;
  wallet: anchor.Wallet;
  tokenProgramId: PublicKey;
  privacyConfig: PublicKey;
  privacyAuthority: PublicKey;
  sharedTokenVault: PublicKey;
  mxeAccount: PublicKey;
  mempoolAccount: PublicKey;
  executingPool: PublicKey;
  clusterAccount: PublicKey;
  signPdaAccount: PublicKey;
  mxePublicKey: Uint8Array;
} | null = null;

// ============================================================================
// MENU SYSTEM
// ============================================================================

function printMenu() {
  console.log("\n");
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║                    PRIVACY MINER MENU                         ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log("║  [D] Deposit     - Add SOL to your encrypted balance          ║");
  console.log("║  [W] Withdraw    - Withdraw SOL from encrypted balance        ║");
  console.log("║  [L] List Claims - Browse & claim pending rewards             ║");
  console.log("║  [S] Stop        - Stop mining and exit                       ║");
  console.log("║  [1] Miner       - Change miner wallet (for rewards)          ║");
  console.log("║  [2] Relayer     - Change relayer wallet (pays fees)          ║");
  console.log("║  [C] Claim Wallet - Set claim wallet keypair path             ║");
  console.log("║  [N] RPC         - Change RPC endpoint                        ║");
  console.log("║  [B] Balance     - Show balance status                        ║");
  console.log("║  [M] Close Menu  - Return to mining                           ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function handleDeposit(
  program: Program,
  mxePublicKey: Uint8Array,
  privacyConfig: PublicKey,
  sharedFeeVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey
) {
  // Show current miner wallet info
  console.log(`\nMiner wallet: ${minerWalletPath}`);
  try {
    const minerKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8")))
    );
    const connection = new anchor.web3.Connection(currentRpcUrl, "confirmed");
    const balance = await connection.getBalance(minerKeypair.publicKey);
    console.log(`  Address: ${minerKeypair.publicKey.toString()}`);
    console.log(`  Balance: ${balance / 1e9} SOL`);
  } catch (err) {
    console.log("  (Unable to load miner wallet)");
    console.log("  Set miner wallet first with option [1]");
    return;
  }

  const amountStr = await promptUser("Enter amount in SOL (e.g., 0.1): ");
  const amountSol = parseFloat(amountStr);

  if (isNaN(amountSol) || amountSol <= 0) {
    console.log("Invalid amount. Returning to menu.");
    return;
  }

  const amountLamports = Math.floor(amountSol * 1e9);
  console.log(`\nDepositing ${amountSol} SOL (${amountLamports} lamports)...`);

  try {
    // Load miner wallet (the one that pays for the deposit)
    const minerKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8")))
    );
    const minerWallet = new anchor.Wallet(minerKeypair);
    const connection = new anchor.web3.Connection(currentRpcUrl, "confirmed");
    const minerProvider = new anchor.AnchorProvider(connection, minerWallet, { commitment: "confirmed" });

    // Create program with miner wallet
    const idl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_privacy.json", "utf-8"));
    const minerProgram = new Program(idl, minerProvider);

    // Load or create miner identity
    const identity = loadOrCreateMinerIdentity();
    const clientPrivateKey = x25519.utils.randomSecretKey();
    const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

    // Encrypt miner_id_hash
    const { ciphertext: encryptedMinerIdHash, nonce } = encryptMinerIdHash(
      identity.minerIdHash,
      mxePublicKey,
      clientPrivateKey
    );

    // Encrypt amount
    const encryptedAmount = encryptAmount(
      BigInt(amountLamports),
      mxePublicKey,
      clientPrivateKey,
      nonce
    );

    // Encrypt signature
    const encryptedSignature = encryptSignature(
      identity.secretKey,
      "deposit",
      BigInt(amountLamports),
      mxePublicKey,
      clientPrivateKey,
      nonce
    );

    // Convert to expected format
    const encryptedMinerIdHashArray: number[][] = encryptedMinerIdHash.map(c => Array.from(c));
    const encryptedAmountArray: number[] = Array.from(encryptedAmount);
    const encryptedSignatureArray: number[][] = encryptedSignature.map(c => Array.from(c));

    // Derive deposit buffer PDA (using miner wallet)
    const [depositBufferPda] = PublicKey.findProgramAddressSync(
      [DEPOSIT_BUFFER_SEED, minerWallet.publicKey.toBuffer(), encryptedMinerIdHash[0].slice(0, 8)],
      POW_PRIVACY_ID
    );

    console.log("Creating deposit buffer...");
    const createBufferTx = await minerProgram.methods
      .createDepositBuffer(
        encryptedMinerIdHashArray,
        encryptedAmountArray,
        encryptedSignatureArray,
        Array.from(clientPublicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
        new anchor.BN(amountLamports),
      )
      .accounts({
        depositor: minerWallet.publicKey,
        privacyConfig: privacyConfig,
        depositBuffer: depositBufferPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`Buffer created: ${createBufferTx.slice(0, 20)}...`);

    // Execute deposit with MPC
    console.log("Executing deposit via MPC...");
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    const depositFeeOffset = Buffer.from(getCompDefAccOffset("deposit_fee")).readUInt32LE();
    const compDefAccount = getCompDefAccAddress(POW_PRIVACY_ID, depositFeeOffset);
    const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset);

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

    const depositTx = await minerProgram.methods
      .depositPrivate(computationOffset)
      .accounts({
        depositor: minerWallet.publicKey,
        privacyConfig: privacyConfig,
        depositBuffer: depositBufferPda,
        owner: minerWallet.publicKey,
        sharedFeeVault: sharedFeeVault,
        systemProgram: SystemProgram.programId,
        signPdaAccount: signPdaAccount,
        mxeAccount: mxeAccount,
        mempoolAccount: mempoolAccount,
        executingPool: executingPool,
        computationAccount: computationAccount,
        compDefAccount: compDefAccount,
        clusterAccount: clusterAccount,
        poolAccount: ARCIUM_FEE_POOL,
        clockAccount: ARCIUM_CLOCK,
        arciumProgram: ARCIUM_PROGRAM_ID,
      })
      .preInstructions([computeBudgetIx])
      .rpc({ skipPreflight: true });

    console.log(`Deposit queued: ${depositTx.slice(0, 20)}...`);

    // Wait for MPC
    console.log("Waiting for MPC confirmation...");
    try {
      const finalizeSig = await awaitComputationFinalization(
        minerProvider, computationOffset, POW_PRIVACY_ID, "confirmed"
      );
      console.log(`MPC finalized: ${finalizeSig.slice(0, 20)}...`);
      console.log(`\n✓ Deposit successful! ${amountSol} SOL added to your encrypted balance.`);
    } catch (e) {
      console.log("MPC timeout - deposit may still complete in background");
    }
  } catch (err: any) {
    console.error("Deposit failed:", err?.message || err);
  }
}

async function handleWithdraw(
  mxePublicKey: Uint8Array,
  privacyConfig: PublicKey,
  sharedFeeVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey
) {
  // Show current miner wallet info
  console.log(`\nMiner wallet: ${minerWalletPath}`);
  try {
    const minerKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8")))
    );
    console.log(`  Address: ${minerKeypair.publicKey.toString()}`);
  } catch (err) {
    console.log("  (Unable to load miner wallet)");
    console.log("  Set miner wallet first with option [1]");
    return;
  }

  const amountStr = await promptUser("Enter amount in SOL (e.g., 0.1): ");
  const amountSol = parseFloat(amountStr);

  if (isNaN(amountSol) || amountSol <= 0) {
    console.log("Invalid amount. Returning to menu.");
    return;
  }

  const amountLamports = Math.floor(amountSol * 1e9);

  let destinationStr = await promptUser("Destination address (leave empty for new random wallet): ");
  let destination: PublicKey;

  if (destinationStr === "" || destinationStr === null) {
    const newWallet = Keypair.generate();
    destination = newWallet.publicKey;

    // Save the new wallet
    const walletsDir = __dirname + "/../wallets-privacy";
    if (!fs.existsSync(walletsDir)) fs.mkdirSync(walletsDir);
    const timestamp = Date.now();
    fs.writeFileSync(
      `${walletsDir}/withdraw-${timestamp}.json`,
      JSON.stringify(Array.from(newWallet.secretKey))
    );
    console.log(`New wallet created and saved to wallets-privacy/withdraw-${timestamp}.json`);
  } else {
    try {
      destination = new PublicKey(destinationStr);
    } catch {
      console.log("Invalid address. Returning to menu.");
      return;
    }
  }

  console.log(`\nWithdrawing ${amountSol} SOL to ${destination.toString().slice(0, 20)}...`);

  try {
    // Load miner wallet (the one that owns the encrypted balance)
    const minerKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8")))
    );
    const minerWallet = new anchor.Wallet(minerKeypair);
    const connection = new anchor.web3.Connection(currentRpcUrl, "confirmed");
    const minerProvider = new anchor.AnchorProvider(connection, minerWallet, { commitment: "confirmed" });

    // Create program with miner wallet
    const idl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_privacy.json", "utf-8"));
    const minerProgram = new Program(idl, minerProvider);

    const identity = loadOrCreateMinerIdentity();
    const clientPrivateKey = x25519.utils.randomSecretKey();
    const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

    // Encrypt miner_id_hash
    const { ciphertext: encryptedMinerIdHash, nonce } = encryptMinerIdHash(
      identity.minerIdHash,
      mxePublicKey,
      clientPrivateKey
    );

    // Encrypt amount
    const encryptedAmount = encryptAmount(
      BigInt(amountLamports),
      mxePublicKey,
      clientPrivateKey,
      nonce
    );

    // Encrypt destination
    const encryptedDestination = encryptDestinationForWithdraw(
      destination,
      mxePublicKey,
      clientPrivateKey,
      nonce
    );

    // Encrypt signature
    const encryptedSignature = encryptSignature(
      identity.secretKey,
      "withdraw",
      BigInt(amountLamports),
      mxePublicKey,
      clientPrivateKey,
      nonce
    );

    // Convert to expected format
    const encryptedMinerIdHashArray: number[][] = encryptedMinerIdHash.map(c => Array.from(c));
    const encryptedAmountArray: number[] = Array.from(encryptedAmount);
    const encryptedDestinationArray: number[][] = encryptedDestination.map(c => Array.from(c));
    const encryptedSignatureArray: number[][] = encryptedSignature.map(c => Array.from(c));

    // Derive withdraw buffer PDA (using miner wallet)
    const [withdrawBufferPda] = PublicKey.findProgramAddressSync(
      [WITHDRAW_BUFFER_SEED, minerWallet.publicKey.toBuffer(), encryptedMinerIdHash[0].slice(0, 8)],
      POW_PRIVACY_ID
    );

    console.log("Creating withdraw buffer...");
    const createBufferTx = await minerProgram.methods
      .createWithdrawBuffer(
        encryptedMinerIdHashArray,
        encryptedAmountArray,
        encryptedDestinationArray,
        encryptedSignatureArray,
        Array.from(clientPublicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
        new anchor.BN(amountLamports),
      )
      .accounts({
        creator: minerWallet.publicKey,
        privacyConfig: privacyConfig,
        withdrawBuffer: withdrawBufferPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`Buffer created: ${createBufferTx.slice(0, 20)}...`);

    // Execute withdrawal with MPC
    console.log("Executing withdrawal via MPC...");
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    const withdrawFeeOffset = Buffer.from(getCompDefAccOffset("withdraw_fee")).readUInt32LE();
    const compDefAccount = getCompDefAccAddress(POW_PRIVACY_ID, withdrawFeeOffset);
    const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset);

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

    const withdrawTx = await minerProgram.methods
      .withdrawPrivate(computationOffset)
      .accounts({
        caller: minerWallet.publicKey,
        privacyConfig: privacyConfig,
        withdrawBuffer: withdrawBufferPda,
        sharedFeeVault: sharedFeeVault,
        destination: destination,
        systemProgram: SystemProgram.programId,
        signPdaAccount: signPdaAccount,
        mxeAccount: mxeAccount,
        mempoolAccount: mempoolAccount,
        executingPool: executingPool,
        computationAccount: computationAccount,
        compDefAccount: compDefAccount,
        clusterAccount: clusterAccount,
        poolAccount: ARCIUM_FEE_POOL,
        clockAccount: ARCIUM_CLOCK,
        arciumProgram: ARCIUM_PROGRAM_ID,
      })
      .preInstructions([computeBudgetIx])
      .rpc({ skipPreflight: true });

    console.log(`Withdrawal queued: ${withdrawTx.slice(0, 20)}...`);

    // Wait for MPC
    console.log("Waiting for MPC verification...");
    try {
      const finalizeSig = await awaitComputationFinalization(
        minerProvider, computationOffset, POW_PRIVACY_ID, "confirmed"
      );
      console.log(`MPC finalized: ${finalizeSig.slice(0, 20)}...`);
      console.log(`\n✓ Withdrawal successful! ${amountSol} SOL sent to ${destination.toString()}`);
    } catch (e) {
      console.log("MPC timeout - withdrawal may still complete in background");
    }
  } catch (err: any) {
    console.error("Withdrawal failed:", err?.message || err);
  }
}

async function handleListClaims() {
  const PAGE_SIZE = 10;
  let currentPage = 0;

  while (true) {
    // Get pending claims from database
    const dbClaims = claimsDb.getPendingClaims();
    const totalPages = Math.ceil(dbClaims.length / PAGE_SIZE) || 1;
    const start = currentPage * PAGE_SIZE;
    const pageClaims = dbClaims.slice(start, start + PAGE_SIZE);

    console.log("\n");
    console.log("╔═══════════════════════════════════════════════════════════════╗");
    console.log("║                    CLAIMS DATABASE                            ║");
    console.log("╠═══════════════════════════════════════════════════════════════╣");

    // Get stats from database
    const stats = claimsDb.getClaimStats();
    console.log(`║  Total: ${stats.total.toString().padEnd(6)} | Claimed: ${stats.claimed.toString().padEnd(6)} | Failed: ${stats.failed.toString().padEnd(6)}   ║`);
    console.log(`║  Pending: ${stats.pending.toString().padEnd(4)} | MPC OK: ${stats.mpcConfirmed.toString().padEnd(5)} | Expired: ${stats.expired.toString().padEnd(5)}  ║`);
    console.log("╠═══════════════════════════════════════════════════════════════╣");

    if (dbClaims.length === 0) {
      console.log("║  No pending claims in database                                ║");
    } else {
      console.log(`║  PENDING CLAIMS (Page ${currentPage + 1}/${totalPages}):                               ║`);
      console.log("║  ─────────────────────────────────────────────────────────    ║");
      for (let i = 0; i < pageClaims.length; i++) {
        const claim = pageClaims[i];
        const age = Math.floor((Date.now() / 1000) - claim.created_at);
        const dest = claim.destination_pubkey.slice(0, 10);
        const statusMap: Record<string, string> = {
          'pending': 'Pending',
          'mpc_confirmed': 'MPC OK',
          'claiming': 'Claiming',
          'failed': `Fail(${claim.retry_count})`,
        };
        const status = statusMap[claim.status] || claim.status;
        const idx = (i + 1).toString().padStart(2, ' ');
        console.log(`║  [${idx}] #${claim.claim_id.toString().padEnd(5)} | ${dest}... | ${age.toString().padStart(5)}s | ${status.padEnd(10)}║`);
      }
    }

    console.log("╠═══════════════════════════════════════════════════════════════╣");
    console.log("║  [N] Next page  [P] Prev page  [A] Claim All  [Q] Back        ║");
    console.log("║  [1-10] Select claim to process individually                  ║");
    console.log("╚═══════════════════════════════════════════════════════════════╝");

    const choice = await promptUser("Enter choice: ");
    const upperChoice = choice.toUpperCase();

    if (upperChoice === 'Q' || upperChoice === '') {
      break;
    } else if (upperChoice === 'N') {
      if (currentPage < totalPages - 1) currentPage++;
      else console.log("Already on last page.");
    } else if (upperChoice === 'P') {
      if (currentPage > 0) currentPage--;
      else console.log("Already on first page.");
    } else if (upperChoice === 'A') {
      // Claim all pending
      await handleClaimAll();
    } else {
      // Try to parse as number for individual claim
      const num = parseInt(choice, 10);
      if (!isNaN(num) && num >= 1 && num <= pageClaims.length) {
        const selectedClaim = pageClaims[num - 1];
        await handleClaimSingle(selectedClaim.claim_id);
      } else {
        console.log("Invalid choice.");
      }
    }
  }
}

async function handleClaimSingle(claimId: number) {
  if (!claimContext) {
    console.log("\nClaim context not initialized. Wait for miner to fully start.");
    return;
  }

  const dbClaim = claimsDb.getClaimByClaimId(claimId);
  if (!dbClaim) {
    console.log(`\nClaim #${claimId} not found in database.`);
    return;
  }

  if (dbClaim.status === 'claimed') {
    console.log(`\nClaim #${claimId} already claimed.`);
    return;
  }

  const age = Math.floor((Date.now() / 1000) - dbClaim.created_at);
  if (age < 30) {
    console.log(`\nClaim #${claimId} is too recent (${age}s old). Wait at least 30s.`);
    return;
  }

  console.log(`\nProcessing claim #${claimId}...`);

  // Convert to claim format and process
  const claim = claimsDb.claimRecordToPendingClaim(dbClaim);

  try {
    await processSingleClaim(
      claimContext.provider,
      claimContext.program,
      claimContext.connection,
      claimContext.wallet,
      claimContext.tokenProgramId,
      claimContext.privacyConfig,
      claimContext.privacyAuthority,
      claimContext.sharedTokenVault,
      claimContext.mxeAccount,
      claimContext.mempoolAccount,
      claimContext.executingPool,
      claimContext.clusterAccount,
      claimContext.signPdaAccount,
      claimContext.mxePublicKey,
      claim
    );
    console.log(`\n✓ Claim #${claimId} processed successfully!`);
  } catch (err: any) {
    console.log(`\n✗ Failed to claim #${claimId}: ${err?.message || err}`);
  }
}

async function handleClaimAll() {
  if (!claimContext) {
    console.log("\nClaim context not initialized. Wait for miner to fully start.");
    return;
  }

  const readyClaims = claimsDb.getClaimsReadyToProcess(30);

  if (readyClaims.length === 0) {
    console.log("\nNo claims ready to process (must be >30s old).");
    return;
  }

  const confirm = await promptUser(`Process ${readyClaims.length} claims? (y/N): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log("Cancelled.");
    return;
  }

  console.log(`\nProcessing ${readyClaims.length} pending claims...`);

  await processPendingClaims(
    claimContext.provider,
    claimContext.program,
    claimContext.connection,
    claimContext.wallet,
    claimContext.tokenProgramId,
    claimContext.privacyConfig,
    claimContext.privacyAuthority,
    claimContext.sharedTokenVault,
    claimContext.mxeAccount,
    claimContext.mempoolAccount,
    claimContext.executingPool,
    claimContext.clusterAccount,
    claimContext.signPdaAccount,
    claimContext.mxePublicKey
  );

  console.log("\nClaim processing complete.");
  const stats = claimsDb.getClaimStats();
  console.log(`Pending: ${stats.pending} | Claimed: ${stats.claimed} | Failed: ${stats.failed}`);
}

async function handleChangeMinerWallet() {
  console.log(`\nCurrent miner wallet: ${minerWalletPath}`);
  try {
    const currentKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(minerWalletPath, "utf-8")))
    );
    console.log(`  Address: ${currentKeypair.publicKey.toString()}`);
  } catch {
    console.log("  (Unable to load current wallet)");
  }

  const newPath = await promptUser("Enter new miner wallet path (or empty to cancel): ");

  if (newPath === "") {
    console.log("Cancelled.");
    return;
  }

  if (!fs.existsSync(newPath)) {
    console.log("File not found. Keeping current miner wallet.");
    return;
  }

  try {
    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(newPath, "utf-8")))
    );
    minerWalletPath = newPath;
    claimsDb.setMinerWalletPath(newPath);
    console.log(`\n✓ Miner wallet changed to: ${keypair.publicKey.toString()}`);
    console.log("  Saved to database. Will persist across restarts.");
    console.log("  Note: RESTART the miner for the change to take full effect.");
  } catch (err) {
    console.log("Invalid keypair file. Keeping current miner wallet.");
  }
}

async function handleChangeRelayer() {
  console.log(`\nCurrent relayer wallet: ${relayerWalletPath}`);
  try {
    const currentKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(relayerWalletPath, "utf-8")))
    );
    console.log(`  Address: ${currentKeypair.publicKey.toString()}`);
  } catch {
    console.log("  (Unable to load current wallet)");
  }

  const newPath = await promptUser("Enter new relayer wallet path (or empty to cancel): ");

  if (newPath === "") {
    console.log("Cancelled.");
    return;
  }

  if (!fs.existsSync(newPath)) {
    console.log("File not found. Keeping current relayer.");
    return;
  }

  try {
    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(newPath, "utf-8")))
    );
    relayerWalletPath = newPath;
    claimsDb.setRelayerWalletPath(newPath);
    console.log(`\n✓ Relayer changed to: ${keypair.publicKey.toString()}`);
    console.log("  Saved to database. Will persist across restarts.");
    console.log("  Note: RESTART the miner for the change to take full effect.");
  } catch (err) {
    console.log("Invalid keypair file. Keeping current relayer.");
  }
}

async function handleChangeClaimWallet() {
  console.log(`\nCurrent claim wallet: ${defaultClaimWalletPath || "None (random keypair per block)"}`);
  if (defaultClaimWalletPath) {
    try {
      const keypair = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(defaultClaimWalletPath, "utf-8")))
      );
      console.log(`  Address: ${keypair.publicKey.toString()}`);
    } catch {
      console.log("  (Unable to load current wallet)");
    }
  }

  const newPath = await promptUser("Enter claim wallet path (or 'random' to use random keypairs): ");

  if (newPath === "" || newPath.toLowerCase() === "random") {
    defaultClaimWalletPath = null;
    claimsDb.clearClaimDestination();
    console.log("\n✓ Claim wallet cleared. Each block will use a random keypair.");
    console.log("  Saved to database. Will persist across restarts.");
    return;
  }

  if (!fs.existsSync(newPath)) {
    console.log("File not found. Keeping current setting.");
    return;
  }

  try {
    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(newPath, "utf-8")))
    );
    defaultClaimWalletPath = newPath;
    claimsDb.setClaimDestination(newPath);
    console.log(`\n✓ Claim wallet set to: ${keypair.publicKey.toString()}`);
    console.log("  Saved to database. Will persist across restarts.");
  } catch {
    console.log("Invalid keypair file. Keeping current setting.");
  }
}

async function handleChangeRpc() {
  console.log(`\nCurrent RPC: ${currentRpcUrl}`);
  console.log("\nCommon RPC endpoints:");
  console.log("  [1] https://api.devnet.solana.com");
  console.log("  [2] https://api.mainnet-beta.solana.com");
  console.log("  [3] Custom URL");

  const choice = await promptUser("Enter choice (1-3 or custom URL): ");

  let newRpc: string;
  switch (choice) {
    case '1':
      newRpc = "https://api.devnet.solana.com";
      break;
    case '2':
      newRpc = "https://api.mainnet-beta.solana.com";
      break;
    case '3':
      newRpc = await promptUser("Enter custom RPC URL: ");
      break;
    default:
      if (choice.startsWith('http')) {
        newRpc = choice;
      } else {
        console.log("Invalid choice. Keeping current RPC.");
        return;
      }
  }

  if (!newRpc || newRpc === "") {
    console.log("Cancelled. Keeping current RPC.");
    return;
  }

  // Test the new RPC
  console.log(`\nTesting RPC: ${newRpc}...`);
  try {
    const testConnection = new anchor.web3.Connection(newRpc, "confirmed");
    const slot = await testConnection.getSlot();
    console.log(`✓ RPC working! Current slot: ${slot}`);

    currentRpcUrl = newRpc;
    claimsDb.setRpcUrl(newRpc);
    console.log(`\n✓ RPC changed to: ${currentRpcUrl}`);
    console.log("  Saved to database. Will persist across restarts.");
    console.log("  Note: RESTART the miner for the change to take full effect.");
  } catch (err: any) {
    console.log(`✗ Failed to connect to RPC: ${err?.message || err}`);
    console.log("Keeping current RPC.");
  }
}

/**
 * Show current mining status when returning from menu
 */
async function showMiningStatus(
  connection: anchor.web3.Connection,
  privacyConfig: PublicKey,
  program: Program
) {
  try {
    // Get pow config
    const [powConfig] = PublicKey.findProgramAddressSync(
      [POW_CONFIG_SEED],
      POW_PROTOCOL_ID
    );
    const powConfigAccount = await connection.getAccountInfo(powConfig);

    if (powConfigAccount) {
      const data = powConfigAccount.data;
      const difficultyLow = data.readBigUInt64LE(72);
      const difficultyHigh = data.readBigUInt64LE(80);
      const difficulty = BigInt(difficultyLow) | (BigInt(difficultyHigh) << 64n);
      const blocksMined = data.readBigUInt64LE(96);
      const challenge = Buffer.from(data.slice(112, 144));

      console.log("\n===============================================================");
      console.log("                    MINING RESUMED");
      console.log("===============================================================");
      console.log(`Block #${blocksMined} | Difficulty: ${difficulty.toLocaleString()}`);
      console.log(`Challenge: ${challenge.toString("hex").substring(0, 16)}...`);
      console.log(`Pending claims: ${pendingClaims.length}`);
      console.log("Press 'M' at any time to open the menu, Ctrl+C to exit");
      console.log("===============================================================\n");
    }
  } catch (err) {
    console.log("\nMining resumed. Press 'M' for menu.\n");
  }
}

async function handleMenu(
  provider: anchor.AnchorProvider,
  program: Program,
  connection: anchor.web3.Connection,
  wallet: anchor.Wallet,
  mxePublicKey: Uint8Array,
  privacyConfig: PublicKey,
  sharedFeeVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey
) {
  menuActive = true;
  killMiningProcess(); // Stop any ongoing GPU mining
  printMenu();

  while (menuActive) {
    const choice = await promptUser("Enter choice: ");

    switch (choice.toUpperCase()) {
      case 'D':
        await handleDeposit(
          program, mxePublicKey,
          privacyConfig, sharedFeeVault, mxeAccount,
          mempoolAccount, executingPool, clusterAccount, signPdaAccount
        );
        printMenu();
        break;

      case 'W':
        await handleWithdraw(
          mxePublicKey,
          privacyConfig, sharedFeeVault, mxeAccount,
          mempoolAccount, executingPool, clusterAccount, signPdaAccount
        );
        printMenu();
        break;

      case 'L':
        await handleListClaims();
        printMenu();
        break;

      case 'N':
        await handleChangeRpc();
        printMenu();
        break;

      case 'S':
        console.log("\nStopping miner...");
        isMining = false;
        menuActive = false;
        break;

      case '1':
        await handleChangeMinerWallet();
        printMenu();
        break;

      case '2':
        await handleChangeRelayer();
        printMenu();
        break;

      case 'C':
        await handleChangeClaimWallet();
        break;

      case 'B':
        await printBalanceStatus(connection);
        break;

      case 'M':
      case '':
        menuActive = false;
        console.log("\nReturning to mining...");
        // Re-enable raw mode for keyboard listener
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
        }
        // Show current mining status
        await showMiningStatus(connection, privacyConfig, program);
        break;

      default:
        console.log("Invalid choice. Try again.");
    }
  }
}

// Setup keyboard listener for menu
function setupKeyboardListener(
  provider: anchor.AnchorProvider,
  program: Program,
  connection: anchor.web3.Connection,
  wallet: anchor.Wallet,
  mxePublicKey: Uint8Array,
  privacyConfig: PublicKey,
  sharedFeeVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey
) {
  // Enable raw mode to capture single keypresses
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', async (key: string) => {
      // Ctrl+C to exit
      if (key === '\u0003') {
        console.log("\nExiting...");
        process.exit();
      }

      // 'm' or 'M' to open menu (only when not already in menu)
      if ((key === 'm' || key === 'M') && !menuActive) {
        await handleMenu(
          provider, program, connection, wallet, mxePublicKey,
          privacyConfig, sharedFeeVault, mxeAccount,
          mempoolAccount, executingPool, clusterAccount, signPdaAccount
        );
      }
    });

    console.log("Press 'M' at any time to open the menu, Ctrl+C to exit\n");
  }
}

// ============================================================================
// MINER IDENTITY MANAGEMENT
// ============================================================================

interface MinerIdentity {
  secretKey: Buffer;
  minerIdHash: Buffer;
}

function loadOrCreateMinerIdentity(): MinerIdentity {
  const identityPath = __dirname + "/../miner-identity.json";

  if (fs.existsSync(identityPath)) {
    const data = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
    const secretKey = Buffer.from(data.secretKey);
    const minerIdHash = createHash('sha256').update(secretKey).digest();
    return { secretKey, minerIdHash };
  }

  // Generate new identity
  const secretKey = randomBytes(32);
  const minerIdHash = createHash('sha256').update(secretKey).digest();

  // Save to file
  fs.writeFileSync(identityPath, JSON.stringify({
    secretKey: Array.from(secretKey),
    note: "This is your miner secret key. Keep it safe! Anyone with this key can withdraw your balance."
  }, null, 2));

  console.log("Generated new miner identity");
  console.log("IMPORTANT: Keep miner-identity.json safe! It controls your balance.");

  return { secretKey, minerIdHash };
}

// ============================================================================
// ENCRYPTION HELPERS
// ============================================================================

function encryptMinerIdHash(
  minerIdHash: Buffer,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array
): { ciphertext: Uint8Array[]; nonce: Buffer } {
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const nonce = randomBytes(16);

  const values = [
    BigInt("0x" + Buffer.from(minerIdHash.slice(0, 8)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(minerIdHash.slice(8, 16)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(minerIdHash.slice(16, 24)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(minerIdHash.slice(24, 32)).reverse().toString("hex")),
  ];

  const ciphertextRaw = cipher.encrypt(values, nonce);
  const ciphertext = ciphertextRaw.map(chunk => Uint8Array.from(chunk));

  return { ciphertext, nonce };
}

function encryptSignature(
  secretKey: Buffer,
  action: string,
  amount: bigint,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array,
  nonce: Buffer
): Uint8Array[] {
  const actionBuffer = Buffer.from(action);
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(amount);

  const signatureInput = Buffer.concat([secretKey, actionBuffer, amountBuffer]);
  const signature = createHash('sha256').update(signatureInput).digest();
  const extendedSig = Buffer.concat([signature, createHash('sha256').update(signature).digest()]);

  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const values: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    values.push(BigInt("0x" + Buffer.from(extendedSig.slice(i * 8, (i + 1) * 8)).reverse().toString("hex")));
  }

  const ciphertextRaw = cipher.encrypt(values, nonce);
  return ciphertextRaw.map(chunk => Uint8Array.from(chunk));
}

function encryptDestinationForWithdraw(
  destination: PublicKey,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array,
  nonce: Buffer
): Uint8Array[] {
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const destBytes = destination.toBuffer();
  const values = [
    BigInt("0x" + Buffer.from(destBytes.slice(0, 8)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(destBytes.slice(8, 16)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(destBytes.slice(16, 24)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(destBytes.slice(24, 32)).reverse().toString("hex")),
  ];

  const ciphertextRaw = cipher.encrypt(values, nonce);
  return ciphertextRaw.map(chunk => Uint8Array.from(chunk));
}

function encryptAmount(
  amount: bigint,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array,
  nonce: Buffer
): Uint8Array {
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const ciphertextRaw = cipher.encrypt([amount], nonce);
  return Uint8Array.from(ciphertextRaw[0]);
}

// ============================================================================
// CRYPTO HELPERS (for mining)
// ============================================================================

function generateSecret(): Buffer {
  return randomBytes(32);
}

function hashSecret(secret: Buffer): Buffer {
  return createHash('sha256').update(secret).digest();
}

function generateDestinationWallet(): Keypair {
  return Keypair.generate();
}

// Encrypt destination wallet pubkey for Arcium MPC
function encryptDestination(
  destinationPubkey: PublicKey,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array
): { ciphertext: Uint8Array[]; clientPublicKey: Uint8Array; nonce: Buffer } {
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const destBytes = destinationPubkey.toBuffer();
  const destValues = [
    BigInt("0x" + destBytes.slice(0, 8).reverse().toString("hex")),
    BigInt("0x" + destBytes.slice(8, 16).reverse().toString("hex")),
    BigInt("0x" + destBytes.slice(16, 24).reverse().toString("hex")),
    BigInt("0x" + destBytes.slice(24, 32).reverse().toString("hex")),
  ];

  const nonce = randomBytes(16);
  const ciphertextRaw = cipher.encrypt(destValues, nonce);
  const ciphertext = ciphertextRaw.map((chunk) => Uint8Array.from(chunk));

  return { ciphertext, clientPublicKey, nonce };
}

// Encrypt claim_id (u64) and secret ([u64; 4]) for verify_and_claim circuit
function encryptClaimData(
  claimId: number,
  secret: Buffer,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array
): {
  encryptedClaimId: Uint8Array;
  encryptedSecret: Uint8Array[];
  clientPublicKey: Uint8Array;
  nonce: Buffer;
} {
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const nonce = randomBytes(16);

  const claimIdCiphertext = cipher.encrypt([BigInt(claimId)], nonce);
  const encryptedClaimId = Uint8Array.from(claimIdCiphertext[0]);

  const secretValues = [
    BigInt("0x" + Buffer.from(secret.slice(0, 8)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(secret.slice(8, 16)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(secret.slice(16, 24)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(secret.slice(24, 32)).reverse().toString("hex")),
  ];
  const secretCiphertext = cipher.encrypt(secretValues, nonce);
  const encryptedSecret = secretCiphertext.map(chunk => Uint8Array.from(chunk));

  return { encryptedClaimId, encryptedSecret, clientPublicKey, nonce };
}

// ============================================================================
// GPU MINING
// ============================================================================

function killMiningProcess() {
  if (currentMiningProcess) {
    currentMiningProcess.kill('SIGTERM');
    currentMiningProcess = null;
  }
}

async function mineWithGpu(
  challenge: string,
  minerPubkey: string,
  blockNumber: number,
  difficulty: number
): Promise<{ nonce: number; hashrate: number; time_ms: number } | null> {
  return new Promise((resolve) => {
    const args = [
      '--benchmark',
      '--backend', 'cuda',
      '--difficulty', difficulty.toString(),
      '--challenge', challenge,
      '--block-number', blockNumber.toString(),
      '--miner-pubkey', minerPubkey
    ];

    currentMiningProcess = spawn('./target/release/miner', args, {
      cwd: '/home/antoninweb3/PoWSolana',
      env: {
        ...process.env,
        RUST_LOG: 'info',
        LD_LIBRARY_PATH: '/usr/lib/wsl/lib'
      }
    });

    let output = '';

    currentMiningProcess.stdout?.on('data', (data) => {
      output += data.toString();
    });

    currentMiningProcess.stderr?.on('data', (data) => {
      output += data.toString();
    });

    currentMiningProcess.on('close', (code) => {
      currentMiningProcess = null;

      if (code !== 0) {
        // Process was killed or failed
        resolve(null);
        return;
      }

      const nonceMatch = output.match(/Nonce found: (\d+)/);
      const timeMatch = output.match(/Time: ([\d.]+)(ms|s)/);
      const hashrateMatch = output.match(/Hashrate: ([\d.]+) MH\/s/);

      if (!nonceMatch || !timeMatch || !hashrateMatch) {
        console.log("Failed to parse miner output");
        resolve(null);
        return;
      }

      const time_ms = timeMatch[2] === 's'
        ? parseFloat(timeMatch[1]) * 1000
        : parseFloat(timeMatch[1]);

      resolve({
        nonce: parseInt(nonceMatch[1]),
        hashrate: parseFloat(hashrateMatch[1]),
        time_ms
      });
    });

    currentMiningProcess.on('error', (error) => {
      console.log(`GPU mining error: ${error.message}`);
      currentMiningProcess = null;
      resolve(null);
    });
  });
}

// ============================================================================
// CLAIM PROCESSOR
// ============================================================================

// Process a single claim
async function processSingleClaim(
  provider: anchor.AnchorProvider,
  program: Program,
  connection: anchor.web3.Connection,
  wallet: anchor.Wallet,
  tokenProgramId: PublicKey,
  privacyConfig: PublicKey,
  privacyAuthority: PublicKey,
  sharedTokenVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey,
  mxePublicKey: Uint8Array,
  claim: {
    claimId: number;
    secret: Buffer;
    destinationWallet: Keypair;
    destinationPubkey?: string; // Added for user-defined destinations
    clientPrivateKey: Uint8Array;
    computationOffset: Buffer;
    createdAt: number;
  }
) {
  const [claimPda] = PublicKey.findProgramAddressSync(
    [CLAIM_SEED, privacyConfig.toBuffer(), Buffer.from(new anchor.BN(claim.claimId).toArray('le', 8))],
    POW_PRIVACY_ID
  );

  // Use destinationPubkey if available (from DB), otherwise use destinationWallet.publicKey
  const destinationPubkey = claim.destinationPubkey
    ? new PublicKey(claim.destinationPubkey)
    : claim.destinationWallet.publicKey;

  // Use the claim wallet (destinationWallet) as the signer for claim transactions
  const claimSigner = claim.destinationWallet;

  const destinationTokenAccount = await createAssociatedTokenAccountIdempotent(
    connection,
    claimSigner, // Use claim wallet to pay for ATA creation
    MINT,
    destinationPubkey,
    {},
    tokenProgramId
  );

  const verifyComputationOffset = new anchor.BN(randomBytes(8), "hex");

  const verifyClaimOffset = Buffer.from(getCompDefAccOffset("verify_and_claim")).readUInt32LE();
  const compDefAccount = getCompDefAccAddress(POW_PRIVACY_ID, verifyClaimOffset);
  const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, verifyComputationOffset);

  console.log(`   Claiming #${claim.claimId} via MPC...`);

  const { encryptedClaimId, encryptedSecret, clientPublicKey: claimClientPubkey, nonce: claimNonce } = encryptClaimData(
    claim.claimId,
    claim.secret,
    mxePublicKey,
    claim.clientPrivateKey
  );

  const [claimRequestBufferPda] = PublicKey.findProgramAddressSync(
    [CLAIM_REQUEST_BUFFER_SEED, claimSigner.publicKey.toBuffer(), Buffer.from(new anchor.BN(claim.claimId).toArray('le', 8))],
    POW_PRIVACY_ID
  );

  console.log(`   TX1: Initializing claim request buffer...`);

  const encryptedSecretArray = encryptedSecret.map(chunk => Array.from(chunk));

  const initBufferTx = await program.methods
    .initClaimRequestBuffer(
      new anchor.BN(claim.claimId),
      Array.from(claimClientPubkey),
      new anchor.BN(deserializeLE(claimNonce).toString()),
      Array.from(claim.secret),
      Array.from(encryptedClaimId),
      encryptedSecretArray
    )
    .accounts({
      payer: claimSigner.publicKey,
      privacyConfig: privacyConfig,
      claimRequestBuffer: claimRequestBufferPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([claimSigner])
    .rpc({ skipPreflight: true });

  console.log(`   TX1 confirmed: ${initBufferTx.slice(0, 20)}...`);

  console.log(`   TX2: Executing claim_reward...`);

  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [HOOK_EXTRA_ACCOUNT_METAS_SEED, MINT.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  );
  const [hookFeeVault] = PublicKey.findProgramAddressSync(
    [HOOK_FEE_VAULT_SEED, MINT.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  );
  const [powConfig] = PublicKey.findProgramAddressSync(
    [POW_CONFIG_SEED],
    POW_PROTOCOL_ID
  );

  const tx = await program.methods
    .claimReward(verifyComputationOffset)
    .accounts({
      claimer: claimSigner.publicKey,
      privacyConfig: privacyConfig,
      privacyAuthority: privacyAuthority,
      claimRequestBuffer: claimRequestBufferPda,
      claim: claimPda,
      mint: MINT,
      sharedTokenVault: sharedTokenVault,
      destinationTokenAccount: destinationTokenAccount,
      tokenProgram: tokenProgramId,
      systemProgram: SystemProgram.programId,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList: extraAccountMetaList,
      hookFeeVault: hookFeeVault,
      powConfig: powConfig,
      powProgram: POW_PROTOCOL_ID,
      signPdaAccount: signPdaAccount,
      mxeAccount: mxeAccount,
      mempoolAccount: mempoolAccount,
      executingPool: executingPool,
      computationAccount: computationAccount,
      compDefAccount: compDefAccount,
      clusterAccount: clusterAccount,
      poolAccount: ARCIUM_FEE_POOL,
      clockAccount: ARCIUM_CLOCK,
      arciumProgram: ARCIUM_PROGRAM_ID,
    })
    .signers([claimSigner])
    .rpc({ skipPreflight: true });

  console.log(`   Claim #${claim.claimId} queued for MPC: ${tx.slice(0, 20)}...`);

  console.log(`   Waiting for MPC verification...`);
  try {
    const finalizeSig = await awaitComputationFinalization(
      provider,
      verifyComputationOffset,
      POW_PRIVACY_ID,
      "confirmed"
    );
    console.log(`   MPC finalized: ${finalizeSig.slice(0, 20)}...`);
    console.log(`   Claimed #${claim.claimId} -> ${destinationPubkey.toString().slice(0, 8)}...`);
  } catch (mpcErr: any) {
    console.log(`   MPC finalization timeout, claim may still complete`);
  }

  // Mark as claimed in database
  claimsDb.markClaimClaimed(claim.claimId, tx);

  // Remove from in-memory array if present
  const memIdx = pendingClaims.findIndex(p => p.claimId === claim.claimId);
  if (memIdx >= 0) pendingClaims.splice(memIdx, 1);

  // Save wallet to file for backup
  const walletsDir = __dirname + "/../wallets-privacy";
  if (!fs.existsSync(walletsDir)) fs.mkdirSync(walletsDir);
  fs.writeFileSync(
    `${walletsDir}/claim-${claim.claimId}.json`,
    JSON.stringify(Array.from(claim.destinationWallet.secretKey))
  );

  console.log(`   ✓ Claim #${claim.claimId} marked as claimed in database`);
}

// Process multiple pending claims
async function processPendingClaims(
  provider: anchor.AnchorProvider,
  program: Program,
  connection: anchor.web3.Connection,
  wallet: anchor.Wallet,
  tokenProgramId: PublicKey,
  privacyConfig: PublicKey,
  privacyAuthority: PublicKey,
  sharedTokenVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey,
  mxePublicKey: Uint8Array
) {
  // Get claims ready to process from database (older than 30s, not yet claimed)
  const dbClaimsReady = claimsDb.getClaimsReadyToProcess(30);

  if (dbClaimsReady.length === 0 && pendingClaims.length === 0) return;

  console.log(`\n Processing claims: ${dbClaimsReady.length} from DB, ${pendingClaims.length} in memory...`);

  // Process claims from database
  for (const dbClaim of dbClaimsReady) {
    // Convert database record to claim format
    const claim = claimsDb.claimRecordToPendingClaim(dbClaim);

    // Use destinationPubkey if available (from DB), otherwise use destinationWallet.publicKey
    const destinationPubkey = claim.destinationPubkey
      ? new PublicKey(claim.destinationPubkey)
      : claim.destinationWallet.publicKey;

    // Use the claim wallet (destinationWallet) as the signer for claim transactions
    const claimSigner = claim.destinationWallet;

    try {
      const [claimPda] = PublicKey.findProgramAddressSync(
        [CLAIM_SEED, privacyConfig.toBuffer(), Buffer.from(new anchor.BN(claim.claimId).toArray('le', 8))],
        POW_PRIVACY_ID
      );

      const destinationTokenAccount = await createAssociatedTokenAccountIdempotent(
        connection,
        claimSigner, // Use claim wallet to pay for ATA creation
        MINT,
        destinationPubkey,
        {},
        tokenProgramId
      );

      const verifyComputationOffset = new anchor.BN(randomBytes(8), "hex");

      const verifyClaimOffset = Buffer.from(getCompDefAccOffset("verify_and_claim")).readUInt32LE();
      const compDefAccount = getCompDefAccAddress(POW_PRIVACY_ID, verifyClaimOffset);
      const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, verifyComputationOffset);

      console.log(`   Claiming #${claim.claimId} via MPC...`);

      const { encryptedClaimId, encryptedSecret, clientPublicKey: claimClientPubkey, nonce: claimNonce } = encryptClaimData(
        claim.claimId,
        claim.secret,
        mxePublicKey,
        claim.clientPrivateKey
      );

      const [claimRequestBufferPda] = PublicKey.findProgramAddressSync(
        [CLAIM_REQUEST_BUFFER_SEED, claimSigner.publicKey.toBuffer(), Buffer.from(new anchor.BN(claim.claimId).toArray('le', 8))],
        POW_PRIVACY_ID
      );

      console.log(`   TX1: Initializing claim request buffer...`);

      const encryptedSecretArray = encryptedSecret.map(chunk => Array.from(chunk));

      const initBufferTx = await program.methods
        .initClaimRequestBuffer(
          new anchor.BN(claim.claimId),
          Array.from(claimClientPubkey),
          new anchor.BN(deserializeLE(claimNonce).toString()),
          Array.from(claim.secret),
          Array.from(encryptedClaimId),
          encryptedSecretArray
        )
        .accounts({
          payer: claimSigner.publicKey,
          privacyConfig: privacyConfig,
          claimRequestBuffer: claimRequestBufferPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([claimSigner])
        .rpc({ skipPreflight: true });

      console.log(`   TX1 confirmed: ${initBufferTx.slice(0, 20)}...`);

      console.log(`   TX2: Executing claim_reward...`);

      const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
        [HOOK_EXTRA_ACCOUNT_METAS_SEED, MINT.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [hookFeeVault] = PublicKey.findProgramAddressSync(
        [HOOK_FEE_VAULT_SEED, MINT.toBuffer()],
        TRANSFER_HOOK_PROGRAM_ID
      );
      const [powConfig] = PublicKey.findProgramAddressSync(
        [POW_CONFIG_SEED],
        POW_PROTOCOL_ID
      );

      const tx = await program.methods
        .claimReward(verifyComputationOffset)
        .accounts({
          claimer: claimSigner.publicKey,
          privacyConfig: privacyConfig,
          privacyAuthority: privacyAuthority,
          claimRequestBuffer: claimRequestBufferPda,
          claim: claimPda,
          mint: MINT,
          sharedTokenVault: sharedTokenVault,
          destinationTokenAccount: destinationTokenAccount,
          tokenProgram: tokenProgramId,
          systemProgram: SystemProgram.programId,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          extraAccountMetaList: extraAccountMetaList,
          hookFeeVault: hookFeeVault,
          powConfig: powConfig,
          powProgram: POW_PROTOCOL_ID,
          signPdaAccount: signPdaAccount,
          mxeAccount: mxeAccount,
          mempoolAccount: mempoolAccount,
          executingPool: executingPool,
          computationAccount: computationAccount,
          compDefAccount: compDefAccount,
          clusterAccount: clusterAccount,
          poolAccount: ARCIUM_FEE_POOL,
          clockAccount: ARCIUM_CLOCK,
          arciumProgram: ARCIUM_PROGRAM_ID,
        })
        .signers([claimSigner])
        .rpc({ skipPreflight: true });

      console.log(`   Claim #${claim.claimId} queued for MPC: ${tx.slice(0, 20)}...`);

      console.log(`   Waiting for MPC verification...`);
      try {
        const finalizeSig = await awaitComputationFinalization(
          provider,
          verifyComputationOffset,
          POW_PRIVACY_ID,
          "confirmed"
        );
        console.log(`   MPC finalized: ${finalizeSig.slice(0, 20)}...`);
        console.log(`   Claimed #${claim.claimId} -> ${destinationPubkey.toString().slice(0, 8)}...`);
      } catch (mpcErr: any) {
        console.log(`   MPC finalization timeout, claim may still complete`);
      }

      // Mark as claimed in database
      claimsDb.markClaimClaimed(claim.claimId, tx);

      // Remove from in-memory array if present
      const memIdx = pendingClaims.findIndex(p => p.claimId === claim.claimId);
      if (memIdx >= 0) pendingClaims.splice(memIdx, 1);

      // Save wallet to file for backup
      const walletsDir = __dirname + "/../wallets-privacy";
      if (!fs.existsSync(walletsDir)) fs.mkdirSync(walletsDir);
      fs.writeFileSync(
        `${walletsDir}/claim-${claim.claimId}.json`,
        JSON.stringify(Array.from(claim.destinationWallet.secretKey))
      );

      console.log(`   ✓ Claim #${claim.claimId} marked as claimed in database`);

    } catch (err: any) {
      const msg = err?.message ?? err?.toString?.() ?? JSON.stringify(err);
      console.log(`   Failed to claim #${claim.claimId}: ${msg}`);
      if (err?.logs) {
        err.logs.slice(-10).forEach((log: string) => console.log(`      ${log}`));
      }
      // Mark as failed in database (will be retried if retry_count < 5)
      claimsDb.markClaimFailed(claim.claimId, msg);
    }
  }
}

// ============================================================================
// ACCOUNT LOGGING
// ============================================================================

async function logAccountOwner(
  connection: anchor.web3.Connection,
  name: string,
  pubkey: PublicKey,
  expectedOwner?: PublicKey
) {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) {
    console.log(`   ${name}: ${pubkey.toString()} (missing)`);
    return;
  }
  const owner = info.owner;
  const ok = expectedOwner ? owner.equals(expectedOwner) : true;
  const ownerLabel = expectedOwner
    ? `${owner.toString()}${ok ? "" : " (unexpected)"}`
    : owner.toString();
  console.log(`   ${name}: ${pubkey.toString()} owner=${ownerLabel}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("");
  console.log("  +=============================================================+");
  console.log("  |       PRIVACY GPU MINER with ARCIUM MPC                     |");
  console.log("  |       Destinations encrypted, only MPC can decrypt          |");
  console.log("  +=============================================================+");
  console.log("");

  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");

  // Wallet (acts as relayer)
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(relayerWalletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);

  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Detect token program from mint owner
  const mintInfo = await connection.getAccountInfo(MINT);
  if (!mintInfo) {
    console.error("Mint account not found:", MINT.toString());
    process.exit(1);
  }
  let tokenProgramId: PublicKey;
  if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    tokenProgramId = TOKEN_2022_PROGRAM_ID;
  } else if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    tokenProgramId = TOKEN_PROGRAM_ID;
  } else {
    console.error("Unsupported mint owner:", mintInfo.owner.toString());
    process.exit(1);
  }

  console.log("Relayer:", wallet.publicKey.toString());
  console.log("RPC:", config.rpc_url);
  console.log("Token Program:", tokenProgramId.toString());
  console.log("Mode: Privacy Pool with Arcium MPC");
  console.log("");

  // =========================================================================
  // Initialize Arcium
  // =========================================================================

  console.log("Initializing Arcium MPC...");
  console.log(
    `   Arcium cluster offset: ${ARCIUM_CLUSTER_OFFSET}${
      ARCIUM_CLUSTER_OFFSET_FROM_ENV ? "" : " (default)"
    }`
  );

  const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
  console.log("   MXE Account:", mxeAccount.toString());

  let mxePublicKey: Uint8Array | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      mxePublicKey = await getMXEPublicKey(provider, POW_PRIVACY_ID);
      if (mxePublicKey) {
        console.log("   MXE x25519 Key:", Buffer.from(mxePublicKey).toString("hex").substring(0, 32) + "...");
        break;
      }
    } catch (e) {
      console.log(`   Attempt ${attempt} failed, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!mxePublicKey) {
    console.error("Failed to get MXE public key! Is DKG complete?");
    process.exit(1);
  }

  const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET);
  const mempoolAccount = getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET);
  const executingPool = getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET);

  console.log("   Cluster:", clusterAccount.toString().substring(0, 16) + "...");
  console.log("   Mempool:", mempoolAccount.toString().substring(0, 16) + "...");
  console.log("   Executing Pool:", executingPool.toString().substring(0, 16) + "...");
  console.log("Arcium MPC ready!\n");

  // =========================================================================
  // Load Programs
  // =========================================================================

  const powProtocolIdl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_protocol.json", "utf-8"));
  const powPrivacyIdl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_privacy.json", "utf-8"));

  const idlProgramId = new PublicKey(powProtocolIdl.address);
  if (!idlProgramId.equals(POW_PROTOCOL_ID)) {
    console.log(
      `Warning: IDL program_id (${idlProgramId.toString()}) differs from constant (${POW_PROTOCOL_ID.toString()}). Using constant.`
    );
  }

  const powProtocol = new Program(powProtocolIdl, provider);
  const powPrivacy = new Program(powPrivacyIdl, provider);

  // PDAs - pow-protocol
  const [powConfig] = PublicKey.findProgramAddressSync([POW_CONFIG_SEED], POW_PROTOCOL_ID);
  const [powFeeVault] = PublicKey.findProgramAddressSync([POW_FEE_VAULT_SEED], POW_PROTOCOL_ID);

  // PDAs - pow-privacy
  const [privacyConfig] = PublicKey.findProgramAddressSync([PRIVACY_CONFIG_SEED], POW_PRIVACY_ID);
  const [privacyAuthority] = PublicKey.findProgramAddressSync(
    [PRIVACY_AUTHORITY_SEED, privacyConfig.toBuffer()],
    POW_PRIVACY_ID
  );
  const [sharedTokenVault] = PublicKey.findProgramAddressSync(
    [SHARED_TOKEN_VAULT_SEED, privacyConfig.toBuffer(), MINT.toBuffer()],
    POW_PRIVACY_ID
  );
  const [sharedFeeVault] = PublicKey.findProgramAddressSync(
    [SHARED_FEE_VAULT_SEED, privacyConfig.toBuffer()],
    POW_PRIVACY_ID
  );

  const [privacyMinerStats] = PublicKey.findProgramAddressSync(
    [POW_MINER_STATS_SEED, privacyAuthority.toBuffer()],
    POW_PROTOCOL_ID
  );

  const [signPdaAccount] = PublicKey.findProgramAddressSync(
    [SIGN_PDA_SEED],
    POW_PRIVACY_ID
  );

  const storeClaimOffset = Buffer.from(getCompDefAccOffset("store_claim")).readUInt32LE();
  const storeClaimCompDef = getCompDefAccAddress(POW_PRIVACY_ID, storeClaimOffset);

  console.log("PDAs:");
  console.log("  Privacy Config:", privacyConfig.toString());
  console.log("  Privacy Authority:", privacyAuthority.toString());
  console.log("  Sign PDA:", signPdaAccount.toString());
  console.log("  store_claim CompDef:", storeClaimCompDef.toString());
  console.log("");

  console.log("Account ownership check:");
  await logAccountOwner(connection, "privacyConfig", privacyConfig, POW_PRIVACY_ID);
  await logAccountOwner(connection, "powConfig", powConfig, POW_PROTOCOL_ID);
  await logAccountOwner(connection, "mint", MINT, tokenProgramId);
  await logAccountOwner(connection, "sharedTokenVault", sharedTokenVault, tokenProgramId);
  await logAccountOwner(connection, "sharedFeeVault", sharedFeeVault);
  await logAccountOwner(connection, "privacyMinerStats", privacyMinerStats);
  await logAccountOwner(connection, "powFeeCollector", powFeeVault);
  await logAccountOwner(connection, "mxeAccount", mxeAccount, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "clusterAccount", clusterAccount, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "mempoolAccount", mempoolAccount, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "executingPool", executingPool, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "compDefAccount(store_claim)", storeClaimCompDef, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "feePool", ARCIUM_FEE_POOL, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "clockAccount", ARCIUM_CLOCK, ARCIUM_PROGRAM_ID);
  await logAccountOwner(connection, "signPdaAccount", signPdaAccount, POW_PRIVACY_ID);
  console.log("");

  // Check if privacy protocol is initialized
  const privacyConfigAccount = await connection.getAccountInfo(privacyConfig);
  if (!privacyConfigAccount) {
    console.log("Privacy protocol not initialized!");
    console.log("Run: npx ts-node scripts/init-privacy.ts");
    process.exit(1);
  }

  // Initialize claim context for manual claiming from menu
  claimContext = {
    provider,
    program: powPrivacy,
    connection,
    wallet,
    tokenProgramId,
    privacyConfig,
    privacyAuthority,
    sharedTokenVault,
    mxeAccount,
    mempoolAccount,
    executingPool,
    clusterAccount,
    signPdaAccount,
    mxePublicKey,
  };

  // Setup keyboard listener for menu
  setupKeyboardListener(
    provider, powPrivacy, connection, wallet, mxePublicKey,
    privacyConfig, sharedFeeVault, mxeAccount,
    mempoolAccount, executingPool, clusterAccount, signPdaAccount
  );

  // =========================================================================
  // Load pending claims from database
  // =========================================================================
  console.log("Loading pending claims from database...");
  const dbPendingClaims = claimsDb.getPendingClaims();
  const stats = claimsDb.getClaimStats();
  console.log(`   Found ${dbPendingClaims.length} pending claims in database`);
  console.log(`   Total claims: ${stats.total} | Claimed: ${stats.claimed} | Failed: ${stats.failed}`);

  // Load into memory for quick access during mining
  for (const dbClaim of dbPendingClaims) {
    const claim = claimsDb.claimRecordToPendingClaim(dbClaim);
    // Check if not already in memory
    if (!pendingClaims.some(p => p.claimId === claim.claimId)) {
      pendingClaims.push({
        claimId: claim.claimId,
        secret: claim.secret,
        destinationWallet: claim.destinationWallet,
        destinationPubkey: claim.destinationPubkey,
        clientPrivateKey: claim.clientPrivateKey,
        computationOffset: new anchor.BN(claim.computationOffset),
        createdAt: claim.createdAt,
      });
    }
  }
  if (pendingClaims.length > 0) {
    console.log(`   Loaded ${pendingClaims.length} claims into memory`);
  }
  console.log("");

  console.log("Starting privacy mining with Arcium MPC...\n");

  let sessionBlockCount = 0;

  while (isMining) {
    // Skip mining if menu is active (auto-pause when menu is open)
    if (menuActive) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    try {
      // NOTE: Claims are now processed manually via menu [K] option
      // This prevents automatic claiming and gives user control

      // =====================================================================
      // 1. FETCH PROTOCOL STATE
      // =====================================================================

      const powConfigAccount = await connection.getAccountInfo(powConfig);
      if (!powConfigAccount) throw new Error("PoW Config not found");

      const data = powConfigAccount.data;
      const difficultyLow = data.readBigUInt64LE(72);
      const difficultyHigh = data.readBigUInt64LE(80);
      const difficulty = BigInt(difficultyLow) | (BigInt(difficultyHigh) << 64n);
      const blocksMined = data.readBigUInt64LE(96);
      const challenge = Buffer.from(data.slice(112, 144));

      const privacyConfigData = await (powPrivacy.account as any).privacyConfig.fetch(privacyConfig);
      const nextClaimId = privacyConfigData.nextClaimId as anchor.BN;

      console.log("===============================================================");
      console.log(`Block #${blocksMined} | Difficulty: ${difficulty.toLocaleString()}`);
      console.log(`Challenge: ${challenge.toString("hex").substring(0, 16)}...`);

      // =====================================================================
      // 2. GENERATE PRIVACY DATA + ENCRYPT WITH ARCIUM
      // =====================================================================

      const secret = generateSecret();
      const secretHash = hashSecret(secret);

      // Use default destination wallet if set, otherwise generate new
      let destinationWallet: Keypair;
      if (defaultClaimWalletPath) {
        try {
          destinationWallet = Keypair.fromSecretKey(
            new Uint8Array(JSON.parse(fs.readFileSync(defaultClaimWalletPath, "utf-8")))
          );
        } catch (e) {
          console.log(`Warning: Could not load claim wallet from ${defaultClaimWalletPath}, using random`);
          destinationWallet = generateDestinationWallet();
        }
      } else {
        destinationWallet = generateDestinationWallet();
      }

      const clientPrivateKey = x25519.utils.randomSecretKey();

      const { ciphertext, clientPublicKey, nonce } = encryptDestination(
        destinationWallet.publicKey,
        mxePublicKey,
        clientPrivateKey
      );

      console.log(`Encrypted destination (MPC-only readable)`);
      console.log(`   Real dest: ${destinationWallet.publicKey.toString().substring(0, 16)}...`);
      console.log(`   Client key: ${Buffer.from(clientPublicKey).toString("hex").substring(0, 16)}...`);

      // Check if menu was opened while preparing
      if (menuActive) {
        console.log("Menu opened, pausing mining...");
        continue;
      }

      // =====================================================================
      // 3. MINE WITH GPU (with parallel challenge monitoring)
      // =====================================================================

      console.log("Mining with GPU...");

      const minerPubkeyHex = privacyAuthority.toBuffer().toString("hex");
      const currentChallenge = challenge.toString("hex");

      // Start challenge monitor in parallel - checks every 5 seconds if someone else mined
      let challengeChanged = false;
      const challengeMonitor = setInterval(async () => {
        try {
          const freshConfig = await connection.getAccountInfo(powConfig);
          if (freshConfig) {
            const freshChallenge = Buffer.from(freshConfig.data.slice(112, 144)).toString("hex");
            if (freshChallenge !== currentChallenge) {
              console.log("\n⚠ New block detected! Stopping current mining...");
              challengeChanged = true;
              killMiningProcess();
              clearInterval(challengeMonitor);
            }
          }
        } catch (e) {
          // Ignore errors in monitor
        }
      }, 5000);

      const result = await mineWithGpu(
        currentChallenge,
        minerPubkeyHex,
        Number(blocksMined),
        Number(difficulty)
      );

      clearInterval(challengeMonitor);

      // If challenge changed while mining, restart the loop
      if (challengeChanged) {
        console.log("Restarting with new challenge...\n");
        continue;
      }

      if (result === null) {
        console.log("GPU mining failed, retrying in 5s...\n");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      console.log(`Nonce: ${result.nonce} | Time: ${(result.time_ms / 1000).toFixed(2)}s | ${result.hashrate.toFixed(2)} MH/s`);

      // =====================================================================
      // 4. SUBMIT VIA PRIVACY LAYER
      // =====================================================================

      console.log("Submitting to Arcium MPC (2-transaction flow)...");

      const storeComputationOffset = new anchor.BN(randomBytes(8), "hex");

      const [claimPda] = PublicKey.findProgramAddressSync(
        [
          CLAIM_SEED,
          privacyConfig.toBuffer(),
          Buffer.from(nextClaimId.toArray('le', 8)),
        ],
        POW_PRIVACY_ID
      );

      const [claimBufferPda] = PublicKey.findProgramAddressSync(
        [
          CLAIM_BUFFER_SEED,
          wallet.publicKey.toBuffer(),
          secretHash,
        ],
        POW_PRIVACY_ID
      );

      const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, storeComputationOffset);

      const encryptedClaimBytes: number[] = new Array(4 * 32).fill(0);
      for (let i = 0; i < ciphertext.length && i < 4; i++) {
        for (let j = 0; j < 32; j++) {
          encryptedClaimBytes[i * 32 + j] = ciphertext[i][j];
        }
      }

      // TX1: Initialize claim buffer
      console.log("   TX1: Initializing claim buffer...");

      const initBufferTx = await powPrivacy.methods
        .initClaimBuffer(
          Array.from(clientPublicKey),
          new anchor.BN(deserializeLE(nonce).toString()),
          Array.from(secretHash)
        )
        .accounts({
          payer: wallet.publicKey,
          privacyConfig: privacyConfig,
          claimBuffer: claimBufferPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true });

      console.log(`   TX1 confirmed: ${initBufferTx.slice(0, 20)}...`);

      // TX2-N: Append encrypted bytes
      const CHUNK_SIZE = 512;
      const totalChunks = Math.ceil(encryptedClaimBytes.length / CHUNK_SIZE);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, encryptedClaimBytes.length);
        const chunk = encryptedClaimBytes.slice(start, end);

        console.log(`   TX${i + 2}: Appending bytes ${start}-${end} (${chunk.length} bytes)...`);

        const appendTx = await powPrivacy.methods
          .appendClaimBuffer(Buffer.from(chunk))
          .accounts({
            payer: wallet.publicKey,
            claimBuffer: claimBufferPda,
          })
          .rpc({ skipPreflight: true });

        console.log(`   TX${i + 2} confirmed: ${appendTx.slice(0, 20)}...`);
      }

      // TX: Submit block
      console.log("   TX2: Submitting block...");

      const method = powPrivacy.methods
        .submitBlockPrivate(
          storeComputationOffset,
          new anchor.BN(result.nonce),
        )
        .accounts({
          relayer: wallet.publicKey,
          privacyConfig: privacyConfig,
          claimBuffer: claimBufferPda,
          privacyAuthority: privacyAuthority,
          claim: claimPda,
          sharedTokenVault: sharedTokenVault,
          sharedFeeVault: sharedFeeVault,
          powConfig: powConfig,
          mint: MINT,
          privacyMinerStats: privacyMinerStats,
          powFeeCollector: powFeeVault,
          powProgram: POW_PROTOCOL_ID,
          tokenProgram: tokenProgramId,
          systemProgram: SystemProgram.programId,
          signPdaAccount: signPdaAccount,
          mxeAccount: mxeAccount,
          mempoolAccount: mempoolAccount,
          executingPool: executingPool,
          computationAccount: computationAccount,
          compDefAccount: storeClaimCompDef,
          clusterAccount: clusterAccount,
          poolAccount: ARCIUM_FEE_POOL,
          clockAccount: ARCIUM_CLOCK,
          arciumProgram: ARCIUM_PROGRAM_ID,
        });

      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      });

      const methodWithBudget = method.preInstructions([computeBudgetIx]);

      try {
        const sim: any = await methodWithBudget.simulate();
        if (sim?.logs) {
          console.log("Simulation logs:");
          sim.logs.forEach((log: string, i: number) => console.log(`  ${i}: ${log}`));
        }
      } catch (simErr: any) {
        console.error("Simulation failed:", simErr?.message || simErr);
        if (simErr?.logs) {
          console.error("Simulation logs:");
          simErr.logs.forEach((log: string, i: number) => console.error(`  ${i}: ${log}`));
        }
        throw simErr;
      }

      const tx = await methodWithBudget.rpc({ skipPreflight: false });

      sessionBlockCount++;

      const claimIdNumber = nextClaimId.toNumber();

      // Store pending claim in database (persistent)
      try {
        claimsDb.insertClaim(
          claimIdNumber,
          secret,
          destinationWallet as Keypair,
          clientPrivateKey,
          storeComputationOffset.toBuffer('le', 8),
          undefined, // amount unknown at this point
          tx
        );
        console.log(`   Claim #${claimIdNumber} saved to database`);
      } catch (dbErr: any) {
        // If duplicate, it's OK (already exists from previous run)
        if (!dbErr?.message?.includes('UNIQUE constraint')) {
          console.error(`   Warning: Failed to save claim to DB: ${dbErr?.message}`);
        }
      }

      // Also keep in memory for quick access
      pendingClaims.push({
        claimId: claimIdNumber,
        secret: secret,
        destinationWallet: destinationWallet as Keypair,
        destinationPubkey: (destinationWallet as Keypair).publicKey.toString(),
        clientPrivateKey: clientPrivateKey,
        computationOffset: storeComputationOffset,
        createdAt: Date.now() / 1000,
      });

      console.log(`Block submitted! TX: ${tx.slice(0, 20)}...`);
      console.log(`Claim #${claimIdNumber} pending MPC | Session: ${sessionBlockCount} blocks`);
      console.log(`Pending claims: ${pendingClaims.length} (in-memory) / ${claimsDb.getClaimStats().pending} (in DB)`);

      // Show balance status
      await printBalanceStatus(connection, sessionBlockCount);

      // Non-blocking MPC finalization - update database on completion
      awaitComputationFinalization(provider, storeComputationOffset, POW_PRIVACY_ID, "confirmed")
        .then((sig) => {
          console.log(`   store_claim #${claimIdNumber} MPC finalized: ${sig.slice(0, 20)}...`);
          claimsDb.markClaimMpcConfirmed(claimIdNumber);
        })
        .catch(() => {
          console.log(`   store_claim #${claimIdNumber} MPC timeout`);
          // Don't mark as failed yet - might still be processing
        });

      await new Promise(r => setTimeout(r, 500));

    } catch (err: any) {
      const msg = err?.message ?? err?.toString?.() ?? String(err);
      console.error("Error:", msg);
      if (err?.error?.errorMessage) {
        console.error("Anchor error:", err.error.errorMessage);
      }
      if (err?.logs) {
        console.error("Logs:");
        err.logs.slice(-10).forEach((log: string, i: number) => console.error(`  ${i}: ${log}`));
      }
      console.log("Retrying in 5s...\n");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log("\nMiner stopped. Goodbye!");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
