/**
 * Claims Database Manager
 *
 * Persists pending claims to SQLite to ensure they are never lost.
 * Even if the miner crashes, claims can be recovered and processed.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3');
import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

// Database path
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'claims.db');

// Claim status enum
export enum ClaimStatus {
  PENDING = 'pending',           // Block submitted, waiting for MPC
  MPC_CONFIRMED = 'mpc_confirmed', // store_claim MPC finished
  CLAIMING = 'claiming',         // Claim request sent
  CLAIMED = 'claimed',           // Successfully claimed
  FAILED = 'failed',             // Failed to claim (will retry)
  EXPIRED = 'expired',           // Too old, won't retry
}

// Claim record interface
export interface ClaimRecord {
  id: number;
  claim_id: number;
  secret: string;                // hex encoded
  destination_pubkey: string;
  destination_secret_key: string; // hex encoded
  client_private_key: string;    // hex encoded
  computation_offset: string;    // hex encoded
  amount: number | null;
  status: ClaimStatus;
  created_at: number;            // unix timestamp
  updated_at: number;            // unix timestamp
  tx_signature: string | null;
  claim_tx_signature: string | null;
  error_message: string | null;
  retry_count: number;
}

// Initialize database
function initDatabase(): any {
  // Ensure data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Create claims table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL UNIQUE,
      secret TEXT NOT NULL,
      destination_pubkey TEXT NOT NULL,
      destination_secret_key TEXT NOT NULL,
      client_private_key TEXT NOT NULL,
      computation_offset TEXT NOT NULL,
      amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tx_signature TEXT,
      claim_tx_signature TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0
    )
  `);

  // Create index on status for faster queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status)
  `);

  // Create index on claim_id for lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claims_claim_id ON claims(claim_id)
  `);

  // Create config table for storing wallet paths and other settings
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  return db;
}

// Global database instance
let db: any = null;

function getDb(): any {
  if (!db) {
    db = initDatabase();
  }
  return db;
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Insert a new claim into the database
 */
export function insertClaim(
  claimId: number,
  secret: Buffer,
  destinationWallet: Keypair,
  clientPrivateKey: Uint8Array,
  computationOffset: Buffer | Uint8Array,
  amount?: number,
  txSignature?: string
): ClaimRecord {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO claims (
      claim_id, secret, destination_pubkey, destination_secret_key,
      client_private_key, computation_offset, amount, status,
      created_at, updated_at, tx_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    claimId,
    secret.toString('hex'),
    destinationWallet.publicKey.toString(),
    Buffer.from(destinationWallet.secretKey).toString('hex'),
    Buffer.from(clientPrivateKey).toString('hex'),
    Buffer.from(computationOffset).toString('hex'),
    amount ?? null,
    ClaimStatus.PENDING,
    now,
    now,
    txSignature ?? null
  );

  return getClaim(result.lastInsertRowid as number)!;
}

/**
 * Get a claim by database ID
 */
export function getClaim(id: number): ClaimRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM claims WHERE id = ?');
  return stmt.get(id) as ClaimRecord | null;
}

/**
 * Get a claim by claim_id
 */
export function getClaimByClaimId(claimId: number): ClaimRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM claims WHERE claim_id = ?');
  return stmt.get(claimId) as ClaimRecord | null;
}

/**
 * Get all claims with a specific status
 */
export function getClaimsByStatus(status: ClaimStatus): ClaimRecord[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM claims WHERE status = ? ORDER BY created_at ASC');
  return stmt.all(status) as ClaimRecord[];
}

/**
 * Get all pending claims (not yet claimed)
 */
export function getPendingClaims(): ClaimRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM claims
    WHERE status IN (?, ?, ?)
    ORDER BY created_at ASC
  `);
  return stmt.all(
    ClaimStatus.PENDING,
    ClaimStatus.MPC_CONFIRMED,
    ClaimStatus.FAILED
  ) as ClaimRecord[];
}

/**
 * Get claims ready to be processed (older than minAge seconds)
 */
export function getClaimsReadyToProcess(minAgeSeconds: number = 30): ClaimRecord[] {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - minAgeSeconds;
  const stmt = db.prepare(`
    SELECT * FROM claims
    WHERE status IN (?, ?, ?)
    AND created_at < ?
    AND retry_count < 5
    ORDER BY created_at ASC
  `);
  return stmt.all(
    ClaimStatus.PENDING,
    ClaimStatus.MPC_CONFIRMED,
    ClaimStatus.FAILED,
    cutoff
  ) as ClaimRecord[];
}

/**
 * Update claim status
 */
export function updateClaimStatus(
  claimId: number,
  status: ClaimStatus,
  errorMessage?: string,
  claimTxSignature?: string
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  if (status === ClaimStatus.FAILED) {
    const stmt = db.prepare(`
      UPDATE claims
      SET status = ?, updated_at = ?, error_message = ?, retry_count = retry_count + 1
      WHERE claim_id = ?
    `);
    stmt.run(status, now, errorMessage ?? null, claimId);
  } else {
    const stmt = db.prepare(`
      UPDATE claims
      SET status = ?, updated_at = ?, claim_tx_signature = COALESCE(?, claim_tx_signature)
      WHERE claim_id = ?
    `);
    stmt.run(status, now, claimTxSignature ?? null, claimId);
  }
}

/**
 * Mark claim as MPC confirmed
 */
export function markClaimMpcConfirmed(claimId: number): void {
  updateClaimStatus(claimId, ClaimStatus.MPC_CONFIRMED);
}

/**
 * Mark claim as claiming (in progress)
 */
export function markClaimClaiming(claimId: number): void {
  updateClaimStatus(claimId, ClaimStatus.CLAIMING);
}

/**
 * Mark claim as successfully claimed
 */
export function markClaimClaimed(claimId: number, txSignature?: string): void {
  updateClaimStatus(claimId, ClaimStatus.CLAIMED, undefined, txSignature);
}

/**
 * Mark claim as failed
 */
export function markClaimFailed(claimId: number, errorMessage: string): void {
  updateClaimStatus(claimId, ClaimStatus.FAILED, errorMessage);
}

/**
 * Mark old failed claims as expired
 */
export function expireOldClaims(maxAgeHours: number = 24): number {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - (maxAgeHours * 3600);
  const stmt = db.prepare(`
    UPDATE claims
    SET status = ?, updated_at = ?
    WHERE status = ? AND created_at < ? AND retry_count >= 5
  `);
  const result = stmt.run(
    ClaimStatus.EXPIRED,
    Math.floor(Date.now() / 1000),
    ClaimStatus.FAILED,
    cutoff
  );
  return result.changes;
}

/**
 * Get statistics about claims
 */
export function getClaimStats(): {
  total: number;
  pending: number;
  mpcConfirmed: number;
  claiming: number;
  claimed: number;
  failed: number;
  expired: number;
} {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'mpc_confirmed' THEN 1 ELSE 0 END) as mpc_confirmed,
      SUM(CASE WHEN status = 'claiming' THEN 1 ELSE 0 END) as claiming,
      SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) as claimed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
    FROM claims
  `);
  const row = stmt.get() as any;
  return {
    total: row.total || 0,
    pending: row.pending || 0,
    mpcConfirmed: row.mpc_confirmed || 0,
    claiming: row.claiming || 0,
    claimed: row.claimed || 0,
    failed: row.failed || 0,
    expired: row.expired || 0,
  };
}

/**
 * Convert a ClaimRecord to the PendingClaim format used by the miner
 */
export function claimRecordToPendingClaim(record: ClaimRecord): {
  claimId: number;
  secret: Buffer;
  destinationWallet: Keypair;
  destinationPubkey: string;
  clientPrivateKey: Uint8Array;
  computationOffset: Buffer;
  amount?: number;
  createdAt: number;
} {
  // Check if we have a valid secret key (not all zeros)
  const secretKeyHex = record.destination_secret_key;
  const isValidSecretKey = secretKeyHex && !/^0+$/.test(secretKeyHex);

  let destinationWallet: Keypair;
  if (isValidSecretKey) {
    // We have a real keypair - reconstruct it
    destinationWallet = Keypair.fromSecretKey(
      Buffer.from(secretKeyHex, 'hex')
    );
  } else {
    // User-defined destination - create dummy keypair, use pubkey from record
    // The actual pubkey is stored in destination_pubkey field
    destinationWallet = Keypair.generate(); // Dummy, won't be used for signing
  }

  return {
    claimId: record.claim_id,
    secret: Buffer.from(record.secret, 'hex'),
    destinationWallet: destinationWallet,
    destinationPubkey: record.destination_pubkey, // Always use this for the actual destination
    clientPrivateKey: new Uint8Array(Buffer.from(record.client_private_key, 'hex')),
    computationOffset: Buffer.from(record.computation_offset, 'hex'),
    amount: record.amount ?? undefined,
    createdAt: record.created_at,
  };
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get recent claims for display
 */
export function getRecentClaims(limit: number = 20): ClaimRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM claims
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as ClaimRecord[];
}

/**
 * Check if claim exists
 */
export function claimExists(claimId: number): boolean {
  const db = getDb();
  const stmt = db.prepare('SELECT 1 FROM claims WHERE claim_id = ?');
  return stmt.get(claimId) !== undefined;
}

// ============================================================================
// CONFIG OPERATIONS
// ============================================================================

/**
 * Get a config value by key
 */
export function getConfig(key: string): string | null {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Set a config value
 */
export function setConfig(key: string, value: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
  `);
  stmt.run(key, value, now, value, now);
}

/**
 * Get miner wallet path
 */
export function getMinerWalletPath(): string | null {
  return getConfig('miner_wallet_path');
}

/**
 * Set miner wallet path
 */
export function setMinerWalletPath(path: string): void {
  setConfig('miner_wallet_path', path);
}

/**
 * Get relayer wallet path
 */
export function getRelayerWalletPath(): string | null {
  return getConfig('relayer_wallet_path');
}

/**
 * Set relayer wallet path
 */
export function setRelayerWalletPath(path: string): void {
  setConfig('relayer_wallet_path', path);
}

/**
 * Get RPC URL
 */
export function getRpcUrl(): string | null {
  return getConfig('rpc_url');
}

/**
 * Set RPC URL
 */
export function setRpcUrl(url: string): void {
  setConfig('rpc_url', url);
}

/**
 * Get default claim destination address
 */
export function getClaimDestination(): string | null {
  return getConfig('claim_destination');
}

/**
 * Set default claim destination address
 */
export function setClaimDestination(address: string): void {
  setConfig('claim_destination', address);
}

/**
 * Clear default claim destination (use random)
 */
export function clearClaimDestination(): void {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM config WHERE key = ?');
  stmt.run('claim_destination');
}

/**
 * Get all config values
 */
export function getAllConfig(): Record<string, string> {
  const db = getDb();
  const stmt = db.prepare('SELECT key, value FROM config');
  const rows = stmt.all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Export for testing
export { getDb, DB_PATH };
