/**
 * Privacy Miner Database Manager
 *
 * Persists relayers, claimers, miner config, and miner state.
 * Replaces the old claims-db.ts (no more Claims system).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3');
import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'privacy-miner.db');

function initDatabase(): any {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Relayers table - wallets that pay tx fees
  db.exec(`
    CREATE TABLE IF NOT EXISTS relayers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      wallet_path TEXT NOT NULL UNIQUE,
      pubkey TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Claimers table - destination wallets for HASHISH withdrawals
  db.exec(`
    CREATE TABLE IF NOT EXISTS claimers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pubkey TEXT NOT NULL UNIQUE,
      wallet_path TEXT,
      added_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Config table (key-value store)
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  return db;
}

let db: any = null;

function getDb(): any {
  if (!db) {
    db = initDatabase();
  }
  return db;
}

// ============================================================================
// RELAYER OPERATIONS
// ============================================================================

export interface RelayerRecord {
  id: number;
  name: string;
  wallet_path: string;
  pubkey: string;
  added_at: number;
  is_active: number;
}

export function addRelayer(name: string, walletPath: string): RelayerRecord | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Validate keypair
  try {
    const keypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf-8')))
    );
    const pubkey = keypair.publicKey.toString();

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO relayers (name, wallet_path, pubkey, added_at, is_active)
      VALUES (?, ?, ?, ?, 1)
    `);
    stmt.run(name, walletPath, pubkey, now);
    return getRelayerByPubkey(pubkey);
  } catch {
    return null;
  }
}

export function removeRelayer(id: number): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM relayers WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getActiveRelayers(): RelayerRecord[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM relayers WHERE is_active = 1 ORDER BY name');
  return stmt.all() as RelayerRecord[];
}

export function getAllRelayers(): RelayerRecord[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM relayers ORDER BY name');
  return stmt.all() as RelayerRecord[];
}

export function getRelayerByPubkey(pubkey: string): RelayerRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM relayers WHERE pubkey = ?');
  return stmt.get(pubkey) as RelayerRecord | null;
}

export function getRandomRelayer(): RelayerRecord | null {
  const relayers = getActiveRelayers();
  if (relayers.length === 0) return null;
  return relayers[Math.floor(Math.random() * relayers.length)];
}

export function loadRelayerKeypair(relayer: RelayerRecord): Keypair | null {
  try {
    return Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(relayer.wallet_path, 'utf-8')))
    );
  } catch {
    return null;
  }
}

// ============================================================================
// CLAIMER OPERATIONS
// ============================================================================

export interface ClaimerRecord {
  id: number;
  name: string;
  pubkey: string;
  wallet_path: string | null;
  added_at: number;
  is_active: number;
}

export function addClaimer(name: string, pubkey: string, walletPath?: string): ClaimerRecord | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO claimers (name, pubkey, wallet_path, added_at, is_active)
      VALUES (?, ?, ?, ?, 1)
    `);
    stmt.run(name, pubkey, walletPath ?? null, now);
    return getClaimerByPubkey(pubkey);
  } catch {
    return null;
  }
}

export function removeClaimer(id: number): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM claimers WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getActiveClaimers(): ClaimerRecord[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM claimers WHERE is_active = 1 ORDER BY name');
  return stmt.all() as ClaimerRecord[];
}

export function getAllClaimers(): ClaimerRecord[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM claimers ORDER BY name');
  return stmt.all() as ClaimerRecord[];
}

export function getClaimerByPubkey(pubkey: string): ClaimerRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM claimers WHERE pubkey = ?');
  return stmt.get(pubkey) as ClaimerRecord | null;
}

export function getRandomClaimer(): ClaimerRecord | null {
  const claimers = getActiveClaimers();
  if (claimers.length === 0) return null;
  return claimers[Math.floor(Math.random() * claimers.length)];
}

// ============================================================================
// CONFIG OPERATIONS
// ============================================================================

export function getConfig(key: string): string | null {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

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

export function getMinerWalletPath(): string | null {
  return getConfig('miner_wallet_path');
}

export function setMinerWalletPath(path: string): void {
  setConfig('miner_wallet_path', path);
}

export function getRpcUrl(): string | null {
  return getConfig('rpc_url');
}

export function setRpcUrl(url: string): void {
  setConfig('rpc_url', url);
}

// ============================================================================
// MINER STATE (encrypted SOL + HASHISH balances)
// ============================================================================

export interface MinerStateLocal {
  balance: bigint;
  stateNonce: bigint;
  reserved: bigint;
  tokenBalance: bigint;
  tokenNonce: bigint;
  tokenReserved: bigint;
}

export function loadMinerState(): MinerStateLocal {
  const statePath = path.join(__dirname, '..', 'miner-state.json');
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      return {
        balance: BigInt(data.balance || '0'),
        stateNonce: BigInt(data.nonce || '0'),
        reserved: BigInt(data.reserved || '0'),
        tokenBalance: BigInt(data.token_balance || '0'),
        tokenNonce: BigInt(data.token_nonce || '0'),
        tokenReserved: BigInt(data.token_reserved || '0'),
      };
    } catch {
      return defaultMinerState();
    }
  }
  return defaultMinerState();
}

export function saveMinerState(state: MinerStateLocal): void {
  const statePath = path.join(__dirname, '..', 'miner-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    balance: state.balance.toString(),
    nonce: state.stateNonce.toString(),
    reserved: state.reserved.toString(),
    token_balance: state.tokenBalance.toString(),
    token_nonce: state.tokenNonce.toString(),
    token_reserved: state.tokenReserved.toString(),
  }, null, 2));
}

function defaultMinerState(): MinerStateLocal {
  return {
    balance: 0n,
    stateNonce: 0n,
    reserved: 0n,
    tokenBalance: 0n,
    tokenNonce: 0n,
    tokenReserved: 0n,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export { getDb, DB_PATH };
