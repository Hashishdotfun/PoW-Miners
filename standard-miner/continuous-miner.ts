#!/usr/bin/env ts-node
/**
 * Continuous Miner - PoW Protocol
 *
 * Mineur en continu qui se connecte au smart contract et mine des blocs
 * Affiche les logs de difficulté, hashrate, et nouveaux blocs
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent
} from "@solana/spl-token";
import * as crypto from "crypto";
import fs from "fs";

// Config - uses devnet by default, or localhost if --local
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
// MINING FUNCTIONS
// ============================================================================

/**
 * Compute SHA256(challenge || miner_pubkey || nonce || block_number)
 * Format: 32 + 32 + 16 + 8 = 88 bytes
 */
function computeHash(challenge: Buffer, minerPubkey: Buffer, nonce: bigint, blockNumber: bigint): Buffer {
  const hasher = crypto.createHash("sha256");

  // Challenge (32 bytes)
  hasher.update(challenge);

  // Miner pubkey (32 bytes) - Anti pool theft
  hasher.update(minerPubkey);

  // Nonce is u128 (16 bytes) in Rust - must match on-chain format
  const nonceBuffer = Buffer.alloc(16);
  nonceBuffer.writeBigUInt64LE(nonce & 0xFFFFFFFFFFFFFFFFn, 0);        // low 8 bytes
  nonceBuffer.writeBigUInt64LE(nonce >> 64n, 8);                        // high 8 bytes
  hasher.update(nonceBuffer);

  // Block number (8 bytes)
  const blockBuffer = Buffer.alloc(8);
  blockBuffer.writeBigUInt64LE(blockNumber);
  hasher.update(blockBuffer);

  return hasher.digest();
}

function mineBlock(challenge: Buffer, minerPubkey: Buffer, blockNumber: bigint, target: bigint, maxNonce: number): { nonce: bigint, hashrate: number } | null {
  const startTime = Date.now();

  for (let nonce = 0; nonce < maxNonce; nonce++) {
    const hash = computeHash(challenge, minerPubkey, BigInt(nonce), blockNumber);
    const hashValue = hash.readBigUInt64LE(0) + (hash.readBigUInt64LE(8) << 64n);

    if (hashValue < target) {
      const elapsed = (Date.now() - startTime) / 1000;
      const hashrate = nonce / elapsed / 1_000_000;
      return { nonce: BigInt(nonce), hashrate };
    }
  }

  return null;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              CONTINUOUS MINER - PoW Protocol                 ║");
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

  console.log("⛏️  Starting continuous mining...\n");

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

      const target = (2n ** 128n - 1n) / difficulty;

      // =====================================================================
      // 2. MINE A BLOCK
      // =====================================================================

      console.log("⛏️  Mining...");
      const startMining = Date.now();

      // Miner pubkey as Buffer (32 bytes)
      const minerPubkey = wallet.publicKey.toBuffer();

      const result = mineBlock(challenge, minerPubkey, blocksMined, target, 100_000_000); // 100M max

      if (result === null) {
        console.log("❌ Mining failed - difficulty too high, retrying in 5s...\n");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const miningTime = (Date.now() - startMining) / 1000;
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

      const nonceNum = new anchor.BN(result.nonce.toString());

      // Add compute budget for the transaction (program has debug logs)
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      });

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
        .preInstructions([computeBudgetIx])
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
        console.error("   Full Logs:");
        err.logs.forEach((log: string, i: number) => console.error(`     [${i}] ${log}`));
      }
      if (err.error) {
        console.error("   Error details:", JSON.stringify(err.error, null, 2));
      }
      // Show accounts used
      console.error("   Accounts:");
      console.error("     Miner:", wallet.publicKey.toString());
      console.error("     PowConfig:", powConfig.toString());
      console.error("     Mint:", MINT.toString());
      console.error("     MinerTokenAccount:", minerTokenAccount.toString());
      console.error("     MinerStats:", minerStats.toString());
      console.error("     FeeVault:", feeVault.toString());
      console.log("   Retrying in 5s...\n");
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
