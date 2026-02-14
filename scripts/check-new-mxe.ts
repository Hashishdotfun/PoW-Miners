#!/usr/bin/env ts-node
import { getMXEAccAddress, getMXEPublicKey } from "@arcium-hq/client";
import { PublicKey, Connection } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

const NEW_PROGRAM = new PublicKey("DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f");
const OLD_PROGRAM = new PublicKey("9iC7Ez6VcqG9TvPEZ31szdnhUrsCYBvmj2u9YeDBWErT");

const mxeNew = getMXEAccAddress(NEW_PROGRAM);
const mxeOld = getMXEAccAddress(OLD_PROGRAM);

console.log("OLD program:", OLD_PROGRAM.toString());
console.log("OLD MXE:", mxeOld.toString());
console.log("");
console.log("NEW program:", NEW_PROGRAM.toString());
console.log("NEW MXE:", mxeNew.toString());

const conn = new Connection(
  "https://devnet.helius-rpc.com/?api-key=f4718f33-4936-4c0b-b947-e079b805c3c8",
  "confirmed"
);

async function check() {
  const newMxeInfo = await conn.getAccountInfo(mxeNew);
  console.log("");
  console.log("--- NEW MXE Account ---");
  if (newMxeInfo === null) {
    console.log("NOT FOUND - MXE not initialized for new program");
    return;
  }

  console.log("Size:", newMxeInfo.data.length, "bytes");
  console.log("Owner:", newMxeInfo.owner.toString());

  const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });

  try {
    const pubkey = await getMXEPublicKey(provider, NEW_PROGRAM);
    if (pubkey) {
      console.log("MXE Public Key:", Buffer.from(pubkey).toString("hex"));
      console.log("DKG: COMPLETE");
    } else {
      console.log("MXE Public Key: null");
      console.log("DKG: NOT COMPLETE");
    }
  } catch (e: any) {
    console.log("getMXEPublicKey error:", e.message);
  }
}

check().catch(console.error);
