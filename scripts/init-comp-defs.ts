#!/usr/bin/env ts-node
/**
 * Initialize computation definitions for pow-privacy on devnet
 * This needs to be run once before the miner can work
 */

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getMXEAccAddress,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getArciumProgramId,
} from "@arcium-hq/client";
import fs from "fs";
import BN from "bn.js";

// Load config (use devnet config)
const config = JSON.parse(fs.readFileSync(__dirname + "/../miner-config.json", "utf-8"));

// Program IDs
const POW_PRIVACY_ID = new PublicKey("AMmu8GcoNUAdnRNKU5AqgNGdLJSLh9WLxxzxFkdtXwCh");
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const LUT_PROGRAM_ID = AddressLookupTableProgram.programId;

// Sign PDA seed
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

// Find the MXE's LUT by reading its last_extended_slot and scanning backwards
async function findMxeLutAddress(connection: anchor.web3.Connection, mxeAccount: PublicKey): Promise<PublicKey> {
  const { getLookupTableAddress } = require("@arcium-hq/client");

  // First, try the known LUT address (hardcoded for this MXE deployment)
  const knownLut = new PublicKey("9idMyViC3aNqa6DHxWJwdbppSk8c49GYJMvpowkBp7vj");
  const knownInfo = await connection.getAccountInfo(knownLut);
  if (knownInfo && knownInfo.owner.equals(LUT_PROGRAM_ID)) {
    // Verify authority matches our MXE
    const authority = new PublicKey(knownInfo.data.subarray(22, 54));
    if (authority.equals(mxeAccount)) {
      return knownLut;
    }
  }

  // Fallback: scan around the last_extended_slot of any known LUT
  // Try getLookupTableAddress with slots near recent slot
  const slot = await connection.getSlot();
  for (let delta = 0; delta < 5000; delta++) {
    const testSlot = new BN(slot - delta);
    try {
      const derived = getLookupTableAddress(POW_PRIVACY_ID, testSlot);
      const acctInfo = await connection.getAccountInfo(derived);
      if (acctInfo && acctInfo.owner.equals(LUT_PROGRAM_ID)) {
        console.log(`Found LUT at slot ${testSlot.toString()}`);
        return derived;
      }
    } catch {}
  }

  throw new Error("Could not find MXE LUT address");
}

async function main() {
  // Setup provider — use deployer wallet (MXE authority), not miner wallet
  const walletPath = process.env.DEPLOYER_WALLET || "/home/antoninweb3/PoWSolana/keys/devnet-deployer.json";
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);
  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  console.log("Initializing computation definitions for pow-privacy...");
  console.log("Wallet:", wallet.publicKey.toString());
  console.log("Program:", POW_PRIVACY_ID.toString());

  // Load the IDL
  const idlPath = __dirname + "/../../PoW-Programs/target/idl/pow_privacy.json";
  let idl: any;
  try {
    idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  } catch {
    const fallbackPath = __dirname + "/../target/idl/pow_privacy.json";
    idl = JSON.parse(fs.readFileSync(fallbackPath, "utf-8"));
  }
  const powPrivacy = new anchor.Program(idl, provider);

  // The MXE account for pow-privacy on devnet
  const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
  console.log("Derived MXE Account:", mxeAccount.toString());

  // Check if it exists
  let mxeAccountInfo = await connection.getAccountInfo(mxeAccount);
  let actualMxeAccount = mxeAccount;

  if (!mxeAccountInfo) {
    // Try known working MXE from devnet
    const knownMxeAccount = new PublicKey("DiwsvsWEdkwp5hCWJ5JE2dU7bNfs6X3VhqR1MDTea8uy");
    mxeAccountInfo = await connection.getAccountInfo(knownMxeAccount);
    if (mxeAccountInfo) {
      actualMxeAccount = knownMxeAccount;
      console.log("Using known MXE Account:", actualMxeAccount.toString());
    } else {
      throw new Error("MXE account not found. Initialize the MXE first with 'arcium init-mxe'.");
    }
  }

  console.log("MXE account data length:", mxeAccountInfo.data.length);

  // Find the LUT address for this MXE
  const lutAddress = await findMxeLutAddress(connection, actualMxeAccount);
  console.log("LUT Address:", lutAddress.toString());

  // Sign PDA
  const [signPdaAccount] = PublicKey.findProgramAddressSync(
    [SIGN_PDA_SEED],
    POW_PRIVACY_ID
  );
  console.log("Sign PDA:", signPdaAccount.toString());

  // Computation definitions to initialize (updated: no more verify_and_claim, added deposit_token + withdraw_token)
  const compDefs: { name: string; methodName: string }[] = [
    { name: "deposit_fee", methodName: "initDepositFeeCompDef" },
    { name: "mine_block", methodName: "initMineBlockCompDef" },
    { name: "withdraw_fee", methodName: "initWithdrawFeeCompDef" },
    { name: "check_miner_balance", methodName: "initCheckBalanceCompDef" },
    { name: "deposit_token", methodName: "initDepositTokenCompDef" },
    { name: "withdraw_token", methodName: "initWithdrawTokenCompDef" },
  ];

  for (const compDef of compDefs) {
    const offset = Buffer.from(getCompDefAccOffset(compDef.name)).readUInt32LE();
    const compDefAddress = getCompDefAccAddress(POW_PRIVACY_ID, offset);

    // Check if already initialized
    const accountInfo = await connection.getAccountInfo(compDefAddress);
    if (accountInfo) {
      console.log(`\n[OK] ${compDef.name} already initialized: ${compDefAddress.toString()}`);
      continue;
    }

    console.log(`\nInitializing ${compDef.name}...`);
    console.log(`  Offset: ${offset}`);
    console.log(`  Address: ${compDefAddress.toString()}`);

    try {
      const method = (powPrivacy.methods as any)[compDef.methodName]();

      const tx = await method
        .accounts({
          payer: wallet.publicKey,
          mxeAccount: actualMxeAccount,
          compDefAccount: compDefAddress,
          addressLookupTable: lutAddress,
          lutProgram: LUT_PROGRAM_ID,
          arciumProgram: ARCIUM_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`  [OK] Initialized: ${tx}`);
    } catch (err: any) {
      if (err?.message?.includes("already in use")) {
        console.log(`  [OK] Already initialized`);
      } else {
        console.error(`  [FAIL] ${err?.message || err}`);
        if (err?.logs) {
          console.error("  Logs:", err.logs.slice(-5).join("\n  "));
        }
      }
    }
  }

  console.log("\nDone! Computation definitions are initialized.");
  console.log("You can now run the miner.");
}

main().catch(console.error);
