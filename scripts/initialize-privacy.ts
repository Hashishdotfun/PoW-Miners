#!/usr/bin/env ts-node
/**
 * Initialize the pow-privacy protocol: creates shared_token_vault, shared_fee_vault, encrypted_state
 * Must be called once after deploying the program (after arcium deploy + init comp defs)
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

// Load config
const config = JSON.parse(fs.readFileSync(__dirname + "/../miner-config-devnet.json", "utf-8"));

// Program IDs
const POW_PRIVACY_ID = new PublicKey("DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f");

// Mint
const MINT = new PublicKey(config.mint || "8MFYkW8Mx4pVm9pAKj15iigDgQ2ZCXXeoRzRHp2x3CEs");

// Seeds
const PRIVACY_CONFIG_SEED = Buffer.from("privacy_config");
const PRIVACY_AUTHORITY_SEED = Buffer.from("privacy_authority");
const SHARED_TOKEN_VAULT_SEED = Buffer.from("shared_token_vault");
const SHARED_FEE_VAULT_SEED = Buffer.from("shared_fee_vault");
const ENCRYPTED_STATE_SEED = Buffer.from("encrypted_state");

async function main() {
  // Setup provider
  const walletPath = config.wallet_path;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);
  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  console.log("Authority:", walletKeypair.publicKey.toString());
  console.log("RPC:", config.rpc_url);
  console.log("Privacy Program:", POW_PRIVACY_ID.toString());
  console.log("Mint:", MINT.toString());

  // Load IDL
  const idlPath = __dirname + "/../target/idl/pow_privacy.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  // Derive PDAs
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
  const [encryptedState] = PublicKey.findProgramAddressSync(
    [ENCRYPTED_STATE_SEED, privacyConfig.toBuffer()],
    POW_PRIVACY_ID
  );

  console.log("\nPDAs:");
  console.log("  privacyConfig:", privacyConfig.toString());
  console.log("  privacyAuthority:", privacyAuthority.toString());
  console.log("  sharedTokenVault:", sharedTokenVault.toString());
  console.log("  sharedFeeVault:", sharedFeeVault.toString());
  console.log("  encryptedState:", encryptedState.toString());

  // Check current state
  const configInfo = await connection.getAccountInfo(privacyConfig);
  const vaultInfo = await connection.getAccountInfo(sharedTokenVault);
  const feeInfo = await connection.getAccountInfo(sharedFeeVault);
  const encStateInfo = await connection.getAccountInfo(encryptedState);

  console.log("\nCurrent state:");
  console.log("  privacyConfig:", configInfo ? `EXISTS (${configInfo.data.length} bytes)` : "NOT FOUND");
  console.log("  sharedTokenVault:", vaultInfo ? `EXISTS (${vaultInfo.data.length} bytes)` : "NOT FOUND");
  console.log("  sharedFeeVault:", feeInfo ? `EXISTS (${feeInfo.data.length} bytes)` : "NOT FOUND");
  console.log("  encryptedState:", encStateInfo ? `EXISTS (${encStateInfo.data.length} bytes)` : "NOT FOUND");

  if (vaultInfo && feeInfo) {
    console.log("\n✅ Already initialized! Vaults exist.");
    return;
  }

  console.log("\n🚀 Calling initialize...");

  try {
    const tx = await (program.methods as any)
      .initialize()
      .accounts({
        authority: walletKeypair.publicKey,
        mint: MINT,
        privacyConfig: privacyConfig,
        privacyAuthority: privacyAuthority,
        sharedTokenVault: sharedTokenVault,
        sharedFeeVault: sharedFeeVault,
        encryptedState: encryptedState,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Initialize TX:", tx);

    // Verify
    const vaultAfter = await connection.getAccountInfo(sharedTokenVault);
    const feeAfter = await connection.getAccountInfo(sharedFeeVault);
    console.log("  sharedTokenVault:", vaultAfter ? "CREATED ✅" : "STILL MISSING ❌");
    console.log("  sharedFeeVault:", feeAfter ? "CREATED ✅" : "STILL MISSING ❌");
  } catch (err: any) {
    console.error("❌ Initialize failed:", err.message || err);
    if (err.logs) {
      console.error("Logs:");
      err.logs.forEach((log: string) => console.error("  ", log));
    }
  }
}

main().catch(console.error);
