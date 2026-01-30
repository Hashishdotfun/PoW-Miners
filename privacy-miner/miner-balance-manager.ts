#!/usr/bin/env ts-node
/**
 * Miner Balance Manager
 *
 * Manage private miner balances using Arcium MPC:
 * - Deposit SOL to miner's encrypted balance
 * - Withdraw SOL from miner's encrypted balance to any destination
 *
 * Usage:
 *   npx ts-node scripts/miner-balance-manager.ts deposit <amount_lamports>
 *   npx ts-node scripts/miner-balance-manager.ts withdraw <amount_lamports> [destination_pubkey]
 *   npx ts-node scripts/miner-balance-manager.ts status
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import {
  getMXEAccAddress,
  getMXEPublicKey,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  awaitComputationFinalization,
  x25519,
  RescueCipher,
  deserializeLE,
  getArciumProgramId,
  getFeePoolAccAddress,
  getClockAccAddress,
} from "@arcium-hq/client";
import { createHash, randomBytes } from 'crypto';
import fs from "fs";

// Config
const useLocal = process.argv.includes("--local");
const configPath = useLocal
  ? __dirname + "/../miner-config.json"
  : __dirname + "/../miner-config-devnet.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// Program IDs
const POW_PRIVACY_ID = new PublicKey("EnchaSHvRoShUp6zrF2awSeQGVYjGFZfjpkdoi2nKPBk");

// Arcium cluster offset
const DEFAULT_CLUSTER_OFFSET = 456;
const ARCIUM_CLUSTER_OFFSET = process.env.ARCIUM_CLUSTER_OFFSET
  ? Number(process.env.ARCIUM_CLUSTER_OFFSET)
  : DEFAULT_CLUSTER_OFFSET;

// Arcium global accounts
const ARCIUM_PROGRAM_ID = getArciumProgramId();
const ARCIUM_FEE_POOL = getFeePoolAccAddress();
const ARCIUM_CLOCK = getClockAccAddress();

// Seeds
const PRIVACY_CONFIG_SEED = Buffer.from("privacy_config");
const SHARED_FEE_VAULT_SEED = Buffer.from("shared_fee_vault");
const DEPOSIT_BUFFER_SEED = Buffer.from("deposit_buffer");
const WITHDRAW_BUFFER_SEED = Buffer.from("withdraw_buffer");
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

// ============================================================================
// MINER ID MANAGEMENT
// ============================================================================

interface MinerIdentity {
  secretKey: Buffer;       // 32-byte secret key (never shared)
  minerIdHash: Buffer;     // SHA256(secretKey) - used as miner identifier
}

function loadOrCreateMinerIdentity(): MinerIdentity {
  const identityPath = __dirname + "/../miner-identity.json";

  if (fs.existsSync(identityPath)) {
    const data = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
    const secretKey = Buffer.from(data.secretKey);
    const minerIdHash = createHash('sha256').update(secretKey).digest();
    console.log("Loaded existing miner identity");
    return { secretKey, minerIdHash };
  }

  // Generate new identity
  const secretKey = randomBytes(32);
  const minerIdHash = createHash('sha256').update(secretKey).digest();

  // Save to file (KEEP THIS SECRET!)
  fs.writeFileSync(identityPath, JSON.stringify({
    secretKey: Array.from(secretKey),
    note: "This is your miner secret key. Keep it safe! Anyone with this key can withdraw your balance."
  }, null, 2));

  console.log("Generated new miner identity");
  console.log("IMPORTANT: Keep miner-identity.json safe! It controls your balance.");

  return { secretKey, minerIdHash };
}

// ============================================================================
// ENCRYPTION HELPERS
// ============================================================================

function encryptMinerIdHash(
  minerIdHash: Buffer,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array
): { ciphertext: Uint8Array[]; nonce: Buffer } {
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const nonce = randomBytes(16);

  // Convert 32-byte hash to 4 x 64-bit values
  const values = [
    BigInt("0x" + Buffer.from(minerIdHash.slice(0, 8)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(minerIdHash.slice(8, 16)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(minerIdHash.slice(16, 24)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(minerIdHash.slice(24, 32)).reverse().toString("hex")),
  ];

  const ciphertextRaw = cipher.encrypt(values, nonce);
  const ciphertext = ciphertextRaw.map(chunk => Uint8Array.from(chunk));

  return { ciphertext, nonce };
}

function encryptSignature(
  secretKey: Buffer,
  action: string,  // "deposit" | "withdraw"
  amount: bigint,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array,
  nonce: Buffer
): Uint8Array[] {
  // Create a signature: SHA256(secretKey || action || amount)
  const actionBuffer = Buffer.from(action);
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(amount);

  const signatureInput = Buffer.concat([secretKey, actionBuffer, amountBuffer]);
  const signature = createHash('sha256').update(signatureInput).digest();

  // Extend to 64 bytes (2 x 32 bytes = 8 x u64)
  const extendedSig = Buffer.concat([signature, createHash('sha256').update(signature).digest()]);

  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  // Convert 64-byte signature to 8 x 64-bit values
  const values: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    values.push(BigInt("0x" + Buffer.from(extendedSig.slice(i * 8, (i + 1) * 8)).reverse().toString("hex")));
  }

  const ciphertextRaw = cipher.encrypt(values, nonce);
  return ciphertextRaw.map(chunk => Uint8Array.from(chunk));
}

function encryptDestination(
  destination: PublicKey,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array,
  nonce: Buffer
): Uint8Array[] {
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const destBytes = destination.toBuffer();
  const values = [
    BigInt("0x" + Buffer.from(destBytes.slice(0, 8)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(destBytes.slice(8, 16)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(destBytes.slice(16, 24)).reverse().toString("hex")),
    BigInt("0x" + Buffer.from(destBytes.slice(24, 32)).reverse().toString("hex")),
  ];

  const ciphertextRaw = cipher.encrypt(values, nonce);
  return ciphertextRaw.map(chunk => Uint8Array.from(chunk));
}

function encryptAmount(
  amount: bigint,
  mxePublicKey: Uint8Array,
  clientPrivateKey: Uint8Array,
  nonce: Buffer
): Uint8Array {
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const ciphertextRaw = cipher.encrypt([amount], nonce);
  return Uint8Array.from(ciphertextRaw[0]);
}

// ============================================================================
// DEPOSIT
// ============================================================================

async function deposit(
  provider: anchor.AnchorProvider,
  program: Program,
  wallet: anchor.Wallet,
  mxePublicKey: Uint8Array,
  privacyConfig: PublicKey,
  sharedFeeVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey,
  amount: number
) {
  console.log(`\nDepositing ${amount} lamports (${amount / 1e9} SOL)...`);

  const identity = loadOrCreateMinerIdentity();
  const clientPrivateKey = x25519.utils.randomSecretKey();
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

  // Encrypt miner_id_hash
  const { ciphertext: encryptedMinerIdHash, nonce } = encryptMinerIdHash(
    identity.minerIdHash,
    mxePublicKey,
    clientPrivateKey
  );

  // Encrypt amount
  const encryptedAmount = encryptAmount(
    BigInt(amount),
    mxePublicKey,
    clientPrivateKey,
    nonce
  );

  // Encrypt signature
  const encryptedSignature = encryptSignature(
    identity.secretKey,
    "deposit",
    BigInt(amount),
    mxePublicKey,
    clientPrivateKey,
    nonce
  );

  // Convert to expected format (4 x 32-byte arrays for miner_id_hash, 8 x 32-byte arrays for signature)
  const encryptedMinerIdHashArray: number[][] = encryptedMinerIdHash.map(c => Array.from(c));
  const encryptedAmountArray: number[] = Array.from(encryptedAmount);
  const encryptedSignatureArray: number[][] = encryptedSignature.map(c => Array.from(c));

  // Derive deposit buffer PDA
  const [depositBufferPda] = PublicKey.findProgramAddressSync(
    [
      DEPOSIT_BUFFER_SEED,
      wallet.publicKey.toBuffer(),
      encryptedMinerIdHash[0].slice(0, 8),
    ],
    POW_PRIVACY_ID
  );

  console.log("Creating deposit buffer...");

  // Step 1: Create deposit buffer
  const createBufferTx = await program.methods
    .createDepositBuffer(
      encryptedMinerIdHashArray,
      encryptedAmountArray,
      encryptedSignatureArray,
      Array.from(clientPublicKey),
      new anchor.BN(deserializeLE(nonce).toString()),
      new anchor.BN(amount),
    )
    .accounts({
      depositor: wallet.publicKey,
      privacyConfig: privacyConfig,
      depositBuffer: depositBufferPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`Buffer created: ${createBufferTx.slice(0, 20)}...`);

  // Step 2: Execute deposit with MPC
  console.log("Executing deposit via MPC...");

  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const depositFeeOffset = Buffer.from(getCompDefAccOffset("deposit_fee")).readUInt32LE();
  const compDefAccount = getCompDefAccAddress(POW_PRIVACY_ID, depositFeeOffset);
  const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset);

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const depositTx = await program.methods
    .depositPrivate(computationOffset)
    .accounts({
      depositor: wallet.publicKey,
      privacyConfig: privacyConfig,
      depositBuffer: depositBufferPda,
      owner: wallet.publicKey,
      sharedFeeVault: sharedFeeVault,
      systemProgram: SystemProgram.programId,
      signPdaAccount: signPdaAccount,
      mxeAccount: mxeAccount,
      mempoolAccount: mempoolAccount,
      executingPool: executingPool,
      computationAccount: computationAccount,
      compDefAccount: compDefAccount,
      clusterAccount: clusterAccount,
      poolAccount: ARCIUM_FEE_POOL,
      clockAccount: ARCIUM_CLOCK,
      arciumProgram: ARCIUM_PROGRAM_ID,
    })
    .preInstructions([computeBudgetIx])
    .rpc({ skipPreflight: true });

  console.log(`Deposit queued: ${depositTx.slice(0, 20)}...`);

  // Wait for MPC
  console.log("Waiting for MPC confirmation...");
  try {
    const finalizeSig = await awaitComputationFinalization(
      provider,
      computationOffset,
      POW_PRIVACY_ID,
      "confirmed"
    );
    console.log(`MPC finalized: ${finalizeSig.slice(0, 20)}...`);
    console.log(`\nDeposit successful! ${amount} lamports added to your encrypted balance.`);
  } catch (e) {
    console.log("MPC timeout - deposit may still complete in background");
  }
}

// ============================================================================
// WITHDRAW
// ============================================================================

async function withdraw(
  provider: anchor.AnchorProvider,
  program: Program,
  wallet: anchor.Wallet,
  mxePublicKey: Uint8Array,
  privacyConfig: PublicKey,
  sharedFeeVault: PublicKey,
  mxeAccount: PublicKey,
  mempoolAccount: PublicKey,
  executingPool: PublicKey,
  clusterAccount: PublicKey,
  signPdaAccount: PublicKey,
  amount: number,
  destinationPubkey?: string
) {
  // Destination defaults to a new random wallet (for privacy)
  const destination = destinationPubkey
    ? new PublicKey(destinationPubkey)
    : Keypair.generate().publicKey;

  console.log(`\nWithdrawing ${amount} lamports (${amount / 1e9} SOL)...`);
  console.log(`Destination: ${destination.toString()}`);

  const identity = loadOrCreateMinerIdentity();
  const clientPrivateKey = x25519.utils.randomSecretKey();
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

  // Encrypt miner_id_hash
  const { ciphertext: encryptedMinerIdHash, nonce } = encryptMinerIdHash(
    identity.minerIdHash,
    mxePublicKey,
    clientPrivateKey
  );

  // Encrypt amount
  const encryptedAmount = encryptAmount(
    BigInt(amount),
    mxePublicKey,
    clientPrivateKey,
    nonce
  );

  // Encrypt destination
  const encryptedDestination = encryptDestination(
    destination,
    mxePublicKey,
    clientPrivateKey,
    nonce
  );

  // Encrypt signature
  const encryptedSignature = encryptSignature(
    identity.secretKey,
    "withdraw",
    BigInt(amount),
    mxePublicKey,
    clientPrivateKey,
    nonce
  );

  // Convert to expected format
  const encryptedMinerIdHashArray: number[][] = encryptedMinerIdHash.map(c => Array.from(c));
  const encryptedAmountArray: number[] = Array.from(encryptedAmount);
  const encryptedDestinationArray: number[][] = encryptedDestination.map(c => Array.from(c));
  const encryptedSignatureArray: number[][] = encryptedSignature.map(c => Array.from(c));

  // Derive withdraw buffer PDA
  const [withdrawBufferPda] = PublicKey.findProgramAddressSync(
    [
      WITHDRAW_BUFFER_SEED,
      wallet.publicKey.toBuffer(),
      encryptedMinerIdHash[0].slice(0, 8),
    ],
    POW_PRIVACY_ID
  );

  console.log("Creating withdraw buffer...");

  // Step 1: Create withdraw buffer
  const createBufferTx = await program.methods
    .createWithdrawBuffer(
      encryptedMinerIdHashArray,
      encryptedAmountArray,
      encryptedDestinationArray,
      encryptedSignatureArray,
      Array.from(clientPublicKey),
      new anchor.BN(deserializeLE(nonce).toString()),
      new anchor.BN(amount),
    )
    .accounts({
      creator: wallet.publicKey,
      privacyConfig: privacyConfig,
      withdrawBuffer: withdrawBufferPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`Buffer created: ${createBufferTx.slice(0, 20)}...`);

  // Step 2: Execute withdrawal with MPC
  console.log("Executing withdrawal via MPC...");

  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const withdrawFeeOffset = Buffer.from(getCompDefAccOffset("withdraw_fee")).readUInt32LE();
  const compDefAccount = getCompDefAccAddress(POW_PRIVACY_ID, withdrawFeeOffset);
  const computationAccount = getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset);

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const withdrawTx = await program.methods
    .withdrawPrivate(computationOffset)
    .accounts({
      caller: wallet.publicKey,
      privacyConfig: privacyConfig,
      withdrawBuffer: withdrawBufferPda,
      sharedFeeVault: sharedFeeVault,
      destination: destination,
      systemProgram: SystemProgram.programId,
      signPdaAccount: signPdaAccount,
      mxeAccount: mxeAccount,
      mempoolAccount: mempoolAccount,
      executingPool: executingPool,
      computationAccount: computationAccount,
      compDefAccount: compDefAccount,
      clusterAccount: clusterAccount,
      poolAccount: ARCIUM_FEE_POOL,
      clockAccount: ARCIUM_CLOCK,
      arciumProgram: ARCIUM_PROGRAM_ID,
    })
    .preInstructions([computeBudgetIx])
    .rpc({ skipPreflight: true });

  console.log(`Withdrawal queued: ${withdrawTx.slice(0, 20)}...`);

  // Wait for MPC
  console.log("Waiting for MPC verification...");
  try {
    const finalizeSig = await awaitComputationFinalization(
      provider,
      computationOffset,
      POW_PRIVACY_ID,
      "confirmed"
    );
    console.log(`MPC finalized: ${finalizeSig.slice(0, 20)}...`);
    console.log(`\nWithdrawal successful! ${amount} lamports sent to ${destination.toString()}`);
  } catch (e) {
    console.log("MPC timeout - withdrawal may still complete in background");
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2).filter(a => a !== "--local");
  const command = args[0];

  if (!command || !["deposit", "withdraw", "status"].includes(command)) {
    console.log("Usage:");
    console.log("  npx ts-node scripts/miner-balance-manager.ts deposit <amount_lamports>");
    console.log("  npx ts-node scripts/miner-balance-manager.ts withdraw <amount_lamports> [destination]");
    console.log("  npx ts-node scripts/miner-balance-manager.ts status");
    console.log("");
    console.log("Examples:");
    console.log("  deposit 100000000    # Deposit 0.1 SOL");
    console.log("  withdraw 50000000    # Withdraw 0.05 SOL to new random address");
    console.log("  withdraw 50000000 ABC...xyz  # Withdraw to specific address");
    process.exit(1);
  }

  const connection = new anchor.web3.Connection(config.rpc_url, "confirmed");
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(config.wallet_path, "utf-8")))
  );
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  console.log("Wallet:", wallet.publicKey.toString());
  console.log("RPC:", config.rpc_url);

  // Load program
  const idl = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/pow_privacy.json", "utf-8"));
  const program = new Program(idl, provider);

  // Get MXE public key
  const mxeAccount = getMXEAccAddress(POW_PRIVACY_ID);
  const mxePublicKey = await getMXEPublicKey(provider, POW_PRIVACY_ID);
  if (!mxePublicKey) {
    console.error("Failed to get MXE public key. Is Arcium initialized?");
    process.exit(1);
  }

  // Derive PDAs
  const [privacyConfig] = PublicKey.findProgramAddressSync([PRIVACY_CONFIG_SEED], POW_PRIVACY_ID);
  const [sharedFeeVault] = PublicKey.findProgramAddressSync(
    [SHARED_FEE_VAULT_SEED, privacyConfig.toBuffer()],
    POW_PRIVACY_ID
  );
  const [signPdaAccount] = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], POW_PRIVACY_ID);

  // Arcium accounts
  const clusterAccount = getClusterAccAddress(ARCIUM_CLUSTER_OFFSET);
  const mempoolAccount = getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET);
  const executingPool = getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET);

  if (command === "deposit") {
    const amount = parseInt(args[1]);
    if (!amount || amount <= 0) {
      console.error("Invalid amount. Usage: deposit <amount_lamports>");
      process.exit(1);
    }

    await deposit(
      provider, program, wallet, mxePublicKey,
      privacyConfig, sharedFeeVault, mxeAccount,
      mempoolAccount, executingPool, clusterAccount, signPdaAccount,
      amount
    );
  } else if (command === "withdraw") {
    const amount = parseInt(args[1]);
    if (!amount || amount <= 0) {
      console.error("Invalid amount. Usage: withdraw <amount_lamports> [destination]");
      process.exit(1);
    }

    const destination = args[2];

    await withdraw(
      provider, program, wallet, mxePublicKey,
      privacyConfig, sharedFeeVault, mxeAccount,
      mempoolAccount, executingPool, clusterAccount, signPdaAccount,
      amount, destination
    );
  } else if (command === "status") {
    const identity = loadOrCreateMinerIdentity();
    console.log("\nMiner Identity:");
    console.log(`  ID Hash: ${identity.minerIdHash.toString("hex").slice(0, 16)}...`);
    console.log("\nNote: Your encrypted balance is stored in Arcium MPC.");
    console.log("There is no on-chain way to check it directly.");
    console.log("Your balance is the sum of deposits minus withdrawals and mining fees.");

    // Show shared vault balance
    const vaultBalance = await connection.getBalance(sharedFeeVault);
    console.log(`\nShared Fee Vault: ${sharedFeeVault.toString()}`);
    console.log(`  Balance: ${vaultBalance} lamports (${vaultBalance / 1e9} SOL)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
