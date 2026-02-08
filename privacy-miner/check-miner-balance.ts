#!/usr/bin/env ts-node
/**
 * Check Miner Balance
 *
 * Shows miner identity info and shared vault balance.
 * Note: Individual encrypted balances are tracked in Arcium MPC
 * and can only be verified during deposit/withdraw/mine operations.
 *
 * Usage:
 *   npx ts-node scripts/check-miner-balance.ts
 *   npx ts-node scripts/check-miner-balance.ts --local
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash } from 'crypto';
import fs from "fs";

// Config
const useLocal = process.argv.includes("--local");
const configPath = useLocal
  ? __dirname + "/../miner-config.json"
  : __dirname + "/../miner-config-devnet.json";

let config: any;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch {
  config = { rpc_url: "https://api.devnet.solana.com" };
}

// Program IDs
const POW_PRIVACY_ID = new PublicKey("HHTo8FEGs8J7VfCD5yDg3ifoKozSaY2cbLfC2U418XjP");

// Seeds
const PRIVACY_CONFIG_SEED = Buffer.from("privacy_config");
const SHARED_FEE_VAULT_SEED = Buffer.from("shared_fee_vault");

// ============================================================================
// MINER ID MANAGEMENT
// ============================================================================

interface MinerIdentity {
  secretKey: Buffer;
  minerIdHash: Buffer;
}

export function loadMinerIdentity(): MinerIdentity | null {
  const identityPath = __dirname + "/../miner-identity.json";

  if (!fs.existsSync(identityPath)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  const secretKey = Buffer.from(data.secretKey);
  const minerIdHash = createHash('sha256').update(secretKey).digest();
  return { secretKey, minerIdHash };
}

// ============================================================================
// BALANCE CHECK
// ============================================================================

export async function getSharedVaultBalance(
  connection?: anchor.web3.Connection
): Promise<number> {
  if (!connection) {
    connection = new anchor.web3.Connection(config.rpc_url, "confirmed");
  }

  const [privacyConfig] = PublicKey.findProgramAddressSync([PRIVACY_CONFIG_SEED], POW_PRIVACY_ID);
  const [sharedFeeVault] = PublicKey.findProgramAddressSync(
    [SHARED_FEE_VAULT_SEED, privacyConfig.toBuffer()],
    POW_PRIVACY_ID
  );

  const balance = await connection.getBalance(sharedFeeVault);
  return balance;
}

export async function printBalanceStatus(
  connection?: anchor.web3.Connection,
  blockNumber?: number
): Promise<void> {
  if (!connection) {
    connection = new anchor.web3.Connection(config.rpc_url, "confirmed");
  }

  const identity = loadMinerIdentity();
  const vaultBalance = await getSharedVaultBalance(connection);

  const idStr = identity
    ? identity.minerIdHash.toString("hex").slice(0, 12) + "..."
    : "Not configured";

  const blockStr = blockNumber !== undefined ? ` Block #${blockNumber}` : "";

  console.log("");
  console.log("┌─────────────────────────────────────────┐");
  console.log(`│      BALANCE STATUS${blockStr.padEnd(21)}│`);
  console.log("├─────────────────────────────────────────┤");
  console.log(`│ Miner ID: ${idStr.padEnd(29)}│`);
  console.log(`│ Shared Vault: ${(vaultBalance / 1e9).toFixed(6).padEnd(16)} SOL    │`);
  console.log("│ (Individual balance in MPC)             │");
  console.log("└─────────────────────────────────────────┘");
  console.log("");
}

export function formatBalanceCompact(vaultBalance: number, minerId?: string): string {
  const idPart = minerId ? minerId.slice(0, 8) : "unknown";
  return `[Miner: ${idPart}...] Vault: ${(vaultBalance / 1e9).toFixed(4)} SOL`;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n=== Check Miner Balance ===\n");

  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");

  const identity = loadMinerIdentity();
  if (!identity) {
    console.log("No miner identity found.");
    console.log("Run 'npx ts-node scripts/miner-balance-manager.ts deposit <amount>' to create one.\n");
  } else {
    console.log("Miner Identity:");
    console.log(`  Secret Key Hash (ID): ${identity.minerIdHash.toString("hex")}`);
  }

  // Show shared vault balance (public info)
  const [privacyConfig] = PublicKey.findProgramAddressSync([PRIVACY_CONFIG_SEED], POW_PRIVACY_ID);
  const [sharedFeeVault] = PublicKey.findProgramAddressSync(
    [SHARED_FEE_VAULT_SEED, privacyConfig.toBuffer()],
    POW_PRIVACY_ID
  );

  const vaultBalance = await connection.getBalance(sharedFeeVault);

  console.log(`\nShared Fee Vault:`);
  console.log(`  Address: ${sharedFeeVault.toString()}`);
  console.log(`  Balance: ${vaultBalance} lamports (${vaultBalance / 1e9} SOL)`);

  console.log("\n─────────────────────────────────────────");
  console.log("Note: Your individual miner balance is stored encrypted");
  console.log("in Arcium MPC. It is verified during:");
  console.log("  • deposit_private  - adds to your balance");
  console.log("  • withdraw_private - deducts from your balance");
  console.log("  • mine_block       - deducts protocol fee");
  console.log("─────────────────────────────────────────\n");

  // Print formatted status
  await printBalanceStatus(connection);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
