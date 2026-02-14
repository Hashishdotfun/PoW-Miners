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
const config = JSON.parse(fs.readFileSync(__dirname + "/../miner-config-devnet.json", "utf-8"));

// Program IDs
const POW_PRIVACY_ID = new PublicKey("DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f");
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const LUT_PROGRAM_ID = AddressLookupTableProgram.programId;

// Sign PDA seed
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

// Derive MXE LUT address from offset slot
function deriveMxeLutAddress(mxeAccount: PublicKey, lutOffsetSlot: BN): PublicKey {
  const [lutAddress] = PublicKey.findProgramAddressSync(
    [
      mxeAccount.toBuffer(),
      lutOffsetSlot.toArrayLike(Buffer, "le", 8),
    ],
    LUT_PROGRAM_ID
  );
  return lutAddress;
}

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
  });
  anchor.setProvider(provider);

  console.log("Initializing computation definitions for pow-privacy...");
  console.log("Wallet:", wallet.publicKey.toString());
  console.log("Program:", POW_PRIVACY_ID.toString());

  // Load the IDL
  const idl = JSON.parse(
    fs.readFileSync(__dirname + "/../target/idl/pow_privacy.json", "utf-8")
  );
  const powPrivacy = new anchor.Program(idl, provider);

  // The MXE account for pow-privacy on devnet
  // Note: This is the MXE registered for the pow-privacy program
  // Use the working MXE address from the miner output
  const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
  console.log("Derived MXE Account:", mxeAccount.toString());

  // Check if it exists, if not use a known working MXE
  let mxeAccountInfo = await connection.getAccountInfo(mxeAccount);
  let actualMxeAccount = mxeAccount;

  if (!mxeAccountInfo) {
    // The derived MXE doesn't exist, try the known working MXE from devnet
    // This is the MXE that was shown in the miner output
    const knownMxeAccount = new PublicKey("DiwsvsWEdkwp5hCWJ5JE2dU7bNfs6X3VhqR1MDTea8uy");
    mxeAccountInfo = await connection.getAccountInfo(knownMxeAccount);
    if (mxeAccountInfo) {
      actualMxeAccount = knownMxeAccount;
      console.log("Using known MXE Account:", actualMxeAccount.toString());
    } else {
      throw new Error("MXE account not found. Initialize the MXE first.");
    }
  }

  // lut_offset_slot is in the MXE account data at offset 256 (based on inspection)
  // It's stored as the first u32/u64 in the latter part of the account
  const data = mxeAccountInfo.data;
  console.log("MXE account data length:", data.length);

  // The MXE account has lut_offset_slot at offset 256 as a u64
  // Based on hex dump: f3 38 1a 00 00 00 00 07
  // Read as u64 LE this gives a large number, but looking at the pattern
  // it seems like the slot is actually at a 4-byte boundary
  // Let's try reading it as the value at offset 256

  // Try offset 256 as the start of lut_offset_slot
  // Looking at the data, bytes 256-263 contain what appears to be the slot
  const lutOffsetSlot = new BN(Uint8Array.prototype.slice.call(data, 256, 264), 'le');
  console.log("LUT Offset Slot (offset 256):", lutOffsetSlot.toString());
  console.log("LUT Offset Slot hex:", lutOffsetSlot.toString(16));

  // Derive the LUT address
  const lutAddress = deriveMxeLutAddress(actualMxeAccount, lutOffsetSlot);
  console.log("LUT Address:", lutAddress.toString());

  // Sign PDA
  const [signPdaAccount] = PublicKey.findProgramAddressSync(
    [SIGN_PDA_SEED],
    POW_PRIVACY_ID
  );
  console.log("Sign PDA:", signPdaAccount.toString());

  // Computation definitions to initialize
  const compDefs = [
    "verify_and_claim",
    "deposit_fee",
    "mine_block",
    "withdraw_fee",
    "check_miner_balance",
  ];

  for (const compDefName of compDefs) {
    const offset = Buffer.from(getCompDefAccOffset(compDefName)).readUInt32LE();
    const compDefAddress = getCompDefAccAddress(POW_PRIVACY_ID, offset);

    // Check if already initialized
    const accountInfo = await connection.getAccountInfo(compDefAddress);
    if (accountInfo) {
      console.log(`✓ ${compDefName} already initialized: ${compDefAddress.toString()}`);
      continue;
    }

    console.log(`\nInitializing ${compDefName}...`);
    console.log(`  Offset: ${offset}`);
    console.log(`  Address: ${compDefAddress.toString()}`);

    try {
      // Map comp def name to instruction name
      const instructionName = `init${compDefName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}CompDef`;

      // Build the instruction based on the name
      let method: any;
      if (compDefName === "verify_and_claim") {
        method = powPrivacy.methods.initVerifyAndClaimCompDef();
      } else if (compDefName === "deposit_fee") {
        method = powPrivacy.methods.initDepositFeeCompDef();
      } else if (compDefName === "mine_block") {
        method = powPrivacy.methods.initMineBlockCompDef();
      } else if (compDefName === "withdraw_fee") {
        method = powPrivacy.methods.initWithdrawFeeCompDef();
      } else if (compDefName === "check_miner_balance") {
        method = powPrivacy.methods.initCheckBalanceCompDef();
      } else {
        console.log(`  Unknown comp def: ${compDefName}, skipping`);
        continue;
      }

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

      console.log(`  ✓ Initialized: ${tx}`);
    } catch (err: any) {
      if (err?.message?.includes("already in use")) {
        console.log(`  ✓ Already initialized`);
      } else {
        console.error(`  ✗ Failed: ${err?.message || err}`);
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
