#!/usr/bin/env ts-node
/**
 * Create an Address Lookup Table (ALT) for pow-privacy transactions
 * This reduces transaction size by compressing 32-byte addresses to 1-byte indices
 */

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  AddressLookupTableProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getArciumProgramId,
  getFeePoolAccAddress,
  getClockAccAddress,
} from "@arcium-hq/client";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";

// Load config (use devnet config)
const config = JSON.parse(fs.readFileSync(__dirname + "/../miner-config-devnet.json", "utf-8"));

// Program IDs (from pow-programs Anchor.toml devnet)
const POW_PROTOCOL_ID = new PublicKey("Ai9XrxSUmDLNCXkoeoqnYuzPgN9F2PeF9WtLq9GyqER");
const POW_PRIVACY_ID = new PublicKey("DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f");
const ARCIUM_PROGRAM_ID = getArciumProgramId();

// Constants
const ARCIUM_CLUSTER_OFFSET = Number(process.env.ARCIUM_CLUSTER_OFFSET || "456");

// Seeds
const POW_CONFIG_SEED = Buffer.from("pow_config");
const POW_FEE_VAULT_SEED = Buffer.from("fee_vault");
const PRIVACY_CONFIG_SEED = Buffer.from("privacy_config");
const PRIVACY_AUTHORITY_SEED = Buffer.from("privacy_authority");
const SHARED_TOKEN_VAULT_SEED = Buffer.from("shared_token_vault");
const SHARED_FEE_VAULT_SEED = Buffer.from("shared_fee_vault");
const PRIVACY_MINER_STATS_SEED = Buffer.from("privacy_miner_stats");
const ARCIUM_SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

// Mint (from config or default)
const MINT = new PublicKey(config.mint || "EwxKGUi1P7e3c3bJTw4kNWNXCNy5TYzGrLZ11R3wLGsP");

async function main() {
  // Setup provider
  const walletPath = config.wallet_path;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);
  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");

  console.log("Creating Address Lookup Table for pow-privacy...");
  console.log("Wallet:", wallet.publicKey.toString());

  // Derive all static addresses
  const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
  const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET);
  const mempoolAccount = getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET);
  const executingPool = getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET);

  // CompDef for mine_block
  const mineBlockCompDefOffset = Buffer.from(getCompDefAccOffset("mine_block")).readUInt32LE();
  const mineBlockCompDef = getCompDefAccAddress(POW_PRIVACY_ID, mineBlockCompDefOffset);

  // Arcium fee pool and clock
  const ARCIUM_FEE_POOL = getFeePoolAccAddress();
  const ARCIUM_CLOCK = getClockAccAddress();

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
    [PRIVACY_MINER_STATS_SEED, privacyConfig.toBuffer(), privacyAuthority.toBuffer()],
    POW_PRIVACY_ID
  );
  const [signPdaAccount] = PublicKey.findProgramAddressSync(
    [ARCIUM_SIGN_PDA_SEED],
    POW_PRIVACY_ID
  );

  // Collect all static addresses to add to ALT
  const addresses: PublicKey[] = [
    // Programs
    POW_PROTOCOL_ID,
    POW_PRIVACY_ID,
    ARCIUM_PROGRAM_ID,
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,

    // pow-protocol PDAs
    powConfig,
    powFeeVault,
    MINT,

    // pow-privacy PDAs
    privacyConfig,
    privacyAuthority,
    sharedTokenVault,
    sharedFeeVault,
    privacyMinerStats,
    signPdaAccount,

    // Arcium accounts
    mxeAccount,
    clusterAccount,
    mempoolAccount,
    executingPool,
    mineBlockCompDef,
    ARCIUM_FEE_POOL,
    ARCIUM_CLOCK,
  ];

  console.log(`\nAddresses to add to ALT (${addresses.length} total):`);
  addresses.forEach((addr, i) => {
    console.log(`  ${i}: ${addr.toString()}`);
  });

  // Get recent slot
  const slot = await connection.getSlot();

  // Create ALT
  console.log("\nCreating Address Lookup Table...");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot: slot,
  });

  // Extend ALT with addresses
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: wallet.publicKey,
    authority: wallet.publicKey,
    lookupTable: altAddress,
    addresses: addresses,
  });

  // Send transaction
  const tx = new anchor.web3.Transaction().add(createIx, extendIx);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(walletKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`\nALT created successfully!`);
  console.log(`ALT Address: ${altAddress.toString()}`);
  console.log(`Transaction: ${sig}`);

  // Save ALT address to config
  const altConfigPath = __dirname + "/../alt-config.json";
  fs.writeFileSync(altConfigPath, JSON.stringify({
    altAddress: altAddress.toString(),
    createdAt: new Date().toISOString(),
    addresses: addresses.map(a => a.toString()),
  }, null, 2));
  console.log(`\nALT config saved to: ${altConfigPath}`);

  console.log("\nWait a few seconds for the ALT to be activated, then you can use it in the miner.");
}

main().catch(console.error);
