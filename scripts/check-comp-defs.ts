#!/usr/bin/env ts-node
import { getMXEAccAddress, getCompDefAccOffset, getCompDefAccAddress } from "@arcium-hq/client";
import { PublicKey, Connection } from "@solana/web3.js";

const NEW_PROGRAM = new PublicKey("DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f");
const conn = new Connection(
  "https://devnet.helius-rpc.com/?api-key=f4718f33-4936-4c0b-b947-e079b805c3c8",
  "confirmed"
);

const compDefs = ["verify_and_claim", "deposit_fee", "mine_block", "withdraw_fee", "check_miner_balance"];

async function check() {
  console.log("Checking comp defs for:", NEW_PROGRAM.toString());
  console.log("MXE:", getMXEAccAddress(NEW_PROGRAM).toString());
  console.log("");

  for (const name of compDefs) {
    const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
    const addr = getCompDefAccAddress(NEW_PROGRAM, offset);
    const info = await conn.getAccountInfo(addr);
    const status = info ? `EXISTS (${info.data.length} bytes)` : "NOT FOUND";
    console.log(`  ${name}: ${status} [${addr.toString()}]`);
  }
}

check().catch(console.error);
