#!/usr/bin/env ts-node
/**
 * Continuous GPU Miner - PoW Protocol
 *
 * Utilise le miner GPU Rust pour miner, puis soumet les preuves au smart contract
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent
} from "@solana/spl-token";
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from "fs";

const execAsync = promisify(exec);

// Config - utilise devnet par défaut, ou localhost si --local
const useLocal = process.argv.includes("--local");
const configPath = useLocal
  ? __dirname + "/../miner-config.json"
  : __dirname + "/../miner-config-devnet.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
console.log(`Using config: ${useLocal ? "localhost" : "devnet"}`);

const POW_PROTOCOL_ID = new PublicKey(config.program_id);
const MINT = new PublicKey(config.mint);

// Seeds
const POW_CONFIG_SEED = Buffer.from("pow_config");
const FEE_VAULT_SEED = Buffer.from("fee_vault");
const MINER_STATS_SEED = Buffer.from("miner_stats");

// ============================================================================
// GPU MINING via Rust miner
// ============================================================================

async function mineWithGpu(challenge: string, minerPubkey: string, blockNumber: number, difficulty: number): Promise<{ nonce: number, hashrate: number, time_ms: number } | null> {
  try {
    // Pass miner pubkey to Rust miner for anti-pool-theft hash computation
    const cmd = `cd /home/antoninweb3/PoWSolana && LD_LIBRARY_PATH=/usr/lib/wsl/lib:$LD_LIBRARY_PATH ./target/release/miner --benchmark --backend cuda --difficulty ${difficulty} --challenge ${challenge} --block-number ${blockNumber} --miner-pubkey ${minerPubkey}`;

    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 1800000, // 30 min max pour les hautes difficultés
      env: {
        ...process.env,
        RUST_LOG: 'info',
        LD_LIBRARY_PATH: '/usr/lib/wsl/lib'
      }
    });

    const output = stdout + stderr;

    const nonceMatch = output.match(/Nonce found: (\d+)/);
    const timeMatch = output.match(/Time: ([\d.]+)(ms|s)/);
    const hashrateMatch = output.match(/Hashrate: ([\d.]+) MH\/s/);

    if (!nonceMatch || !timeMatch || !hashrateMatch) {
      console.log("❌ Failed to parse miner output");
      return null;
    }

    const time_ms = timeMatch[2] === 's'
      ? parseFloat(timeMatch[1]) * 1000
      : parseFloat(timeMatch[1]);

    return {
      nonce: parseInt(nonceMatch[1]),
      hashrate: parseFloat(hashrateMatch[1]),
      time_ms
    };
  } catch (error: any) {
    console.log(`❌ GPU mining error: ${error.message}`);
    return null;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║            CONTINUOUS GPU MINER - PoW Protocol               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Connection
  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");

  // Wallet
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(config.wallet_path, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);

  console.log("📍 Miner:", wallet.publicKey.toString());
  console.log("   RPC:", config.rpc_url);
  console.log("   Backend: CUDA GPU");
  console.log("");

  // Load program
  const idlPath = __dirname + "/../target/idl/pow_protocol.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program(idl, provider);

  // PDAs
  const [powConfig] = PublicKey.findProgramAddressSync(
    [POW_CONFIG_SEED],
    POW_PROTOCOL_ID
  );

  const [feeVault] = PublicKey.findProgramAddressSync(
    [FEE_VAULT_SEED],
    POW_PROTOCOL_ID
  );

  const [minerStats] = PublicKey.findProgramAddressSync(
    [MINER_STATS_SEED, wallet.publicKey.toBuffer()],
    POW_PROTOCOL_ID
  );

  // Token account
  const minerTokenAccount = getAssociatedTokenAddressSync(
    MINT,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Create token account if needed
  console.log("🪙 Ensuring token account exists...");
  await createAssociatedTokenAccountIdempotent(
    connection,
    wallet.payer,
    MINT,
    wallet.publicKey,
    {},
    TOKEN_2022_PROGRAM_ID
  );
  console.log("   ✅ Token account ready\n");

  console.log("⛏️  Starting continuous GPU mining...\n");

  let sessionBlockCount = 0;
  let totalHashrate = 0;
  let hashrateCount = 0;

  while (true) {
    try {
      // =====================================================================
      // 1. FETCH PROTOCOL STATE
      // =====================================================================

      const configAccountInfo = await connection.getAccountInfo(powConfig);
      if (!configAccountInfo) {
        throw new Error("PoW Config not found");
      }

      const data = configAccountInfo.data;

      // Read difficulty as u128 (16 bytes) at offset 72
      const difficultyLow = data.readBigUInt64LE(72);
      const difficultyHigh = data.readBigUInt64LE(80);
      const difficulty = BigInt(difficultyLow) | (BigInt(difficultyHigh) << 64n);

      // blocks_mined at offset 96
      const blocksMined = data.readBigUInt64LE(96);

      // Challenge at offset 112
      const challenge = Buffer.from(data.slice(112, 144));

      console.log("═══════════════════════════════════════════════════════════════");
      console.log(`📦 Block #${blocksMined}`);
      console.log(`⚙️  Difficulty: ${difficulty.toLocaleString()}`);
      console.log(`🎲 Challenge: ${challenge.toString("hex").substring(0, 16)}...`);

      // =====================================================================
      // 2. MINE WITH GPU
      // =====================================================================

      console.log("⛏️  Mining with GPU...");

      // Convert miner pubkey to hex for Rust miner
      const minerPubkeyHex = wallet.publicKey.toBuffer().toString("hex");

      const result = await mineWithGpu(
        challenge.toString("hex"),
        minerPubkeyHex,
        Number(blocksMined),
        Number(difficulty)
      );

      if (result === null) {
        console.log("❌ GPU mining failed, retrying in 5s...\n");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const miningTime = result.time_ms / 1000;
      totalHashrate += result.hashrate;
      hashrateCount++;
      const avgHashrate = totalHashrate / hashrateCount;

      console.log(`✅ Nonce found: ${result.nonce}`);
      console.log(`⏱️  Time: ${miningTime.toFixed(2)}s`);
      console.log(`⚡ Hashrate: ${result.hashrate.toFixed(2)} MH/s (avg: ${avgHashrate.toFixed(2)} MH/s)`);

      // =====================================================================
      // 3. SUBMIT PROOF
      // =====================================================================

      console.log("📤 Submitting proof...");

      const nonceNum = new anchor.BN(result.nonce);

      const tx = await program.methods
        .submitProof(nonceNum)
        .accounts({
          miner: wallet.publicKey,
          powConfig: powConfig,
          mint: MINT,
          minerTokenAccount: minerTokenAccount,
          minerStats: minerStats,
          feeCollector: feeVault,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await connection.confirmTransaction(tx, "confirmed");

      sessionBlockCount++;

      console.log(`🎉 Block mined successfully!`);
      console.log(`   TX: ${tx}`);
      console.log(`   Session total: ${sessionBlockCount} blocks`);
      console.log("");

      // Small delay before next block
      await new Promise(r => setTimeout(r, 500));

    } catch (err: any) {
      console.error("❌ Error:", err.message);
      if (err.logs) {
        console.error("   Logs:", err.logs.slice(0, 5));
      }
      console.log("   Retrying in 5s...\n");
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
