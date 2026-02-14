import { getMXEAccAddress, getMXEPublicKey } from "@arcium-hq/client";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";

const POW_PRIVACY_ID = new PublicKey("DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f");
const config = JSON.parse(fs.readFileSync(__dirname + "/../miner-config-devnet.json", "utf-8"));
const conn = new Connection(config.rpc_url, "confirmed");

async function main() {
  const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
  console.log("MXE Account PDA:", mxeAccount.toString());

  const info = await conn.getAccountInfo(mxeAccount);
  if (!info) {
    console.log("MXE Account DOES NOT EXIST on-chain");
    return;
  }
  console.log("MXE Account EXISTS on-chain");
  console.log("Owner:", info.owner.toString());
  console.log("Data length:", info.data.length);
  console.log("MXE data (hex, first 120 bytes):", info.data.slice(0, 120).toString("hex"));

  // Count non-zero bytes after 8-byte discriminator
  let nonZero = 0;
  for (let i = 8; i < info.data.length; i++) {
    if (info.data[i] !== 0) nonZero++;
  }
  console.log("Non-zero bytes after discriminator:", nonZero, "/", info.data.length - 8);

  // Try the SDK function
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(config.relayer_wallet_path, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });

  try {
    const key = await getMXEPublicKey(provider, POW_PRIVACY_ID);
    if (key) {
      console.log("MXE Public Key:", Buffer.from(key).toString("hex"));
      console.log("DKG is COMPLETE");
    } else {
      console.log("MXE Public Key is NULL - DKG NOT complete");
    }
  } catch (e: any) {
    console.error("getMXEPublicKey error:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n"));
  }
}

main();
