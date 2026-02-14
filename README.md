# PoW Solana Miner

Mining client for the PoW Solana protocol. Supports standard mining (CPU/GPU) and privacy-preserving mining with Arcium MPC.

## Directory Structure

```
pow-miner/
├── gpu-miner/              # Rust GPU miner (CUDA/OpenCL)
│   ├── src/                # Miner source code
│   ├── kernels/            # CUDA/OpenCL GPU kernels
│   ├── build.sh            # Interactive build script
│   └── Cargo.toml
├── privacy-miner/          # Privacy mining with Arcium MPC (TypeScript)
│   ├── continuous-privacy-miner-arcium.ts   # Main privacy miner
│   ├── claims-db.ts        # SQLite claims database
│   ├── miner-balance-manager.ts             # Balance tracking
│   └── check-miner-balance.ts               # Balance checker
├── standard-miner/         # Standard miners (TypeScript)
│   ├── continuous-miner.ts       # CPU miner (Node.js SHA256)
│   └── continuous-gpu-miner.ts   # GPU orchestrator (spawns Rust binary)
├── scripts/                # Utility scripts
│   ├── create-alt.ts       # Create Address Lookup Table
│   ├── init-comp-defs.ts   # Initialize Arcium computation definitions
│   └── initialize-privacy.ts    # Initialize privacy protocol vaults
├── target/idl/             # Anchor IDL files (gitignored, fetched on-chain)
├── alt-config.json         # ALT address for versioned transactions
└── miner-config-devnet.json     # Config file (gitignored)
```

## Prerequisites

- **Node.js** 18+
- **Solana CLI** (for keypair management)
- **Anchor IDL files** in `target/idl/` (fetch from on-chain or copy from PoWSolana)
- **GPU mining:** Rust 1.75+ and CUDA Toolkit 12+ (NVIDIA) or OpenCL SDK (AMD)
- **Privacy mining:** Arcium MPC client (`@arcium-hq/client`)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Fetch IDL files

```bash
mkdir -p target/idl
anchor idl fetch Ai9XrxSUmDLNCXkoeoqnYuzPgN9F2PeF9WtLq9GyqER --provider.cluster devnet -o target/idl/pow_protocol.json
anchor idl fetch DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f --provider.cluster devnet -o target/idl/pow_privacy.json
```

Or copy from the PoWSolana project:

```bash
cp ../PoWSolana/target/idl/pow_protocol.json target/idl/
cp ../PoWSolana/target/idl/pow_privacy.json target/idl/
```

### 3. Create wallets

```bash
# Miner wallet (earns rewards)
solana-keygen new -o keys/miner.json

# Relayer wallet (pays tx fees, privacy miner only)
solana-keygen new -o keys/relayer.json
```

Fund with SOL:

```bash
# Devnet
solana airdrop 2 --keypair keys/miner.json --url devnet
solana airdrop 2 --keypair keys/relayer.json --url devnet
```

### 4. Create config file

```bash
cp miner-config-devnet.example.json miner-config-devnet.json
```

Edit `miner-config-devnet.json`:

```json
{
  "rpc_url": "https://api.devnet.solana.com",
  "program_id": "Ai9XrxSUmDLNCXkoeoqnYuzPgN9F2PeF9WtLq9GyqER",
  "mint": "ACnhuoJn41PQQKfhuHYgAQXR3jPSg1i4zr59Qt68QAUR",
  "wallet_path": "/absolute/path/to/keys/miner.json",
  "relayer_wallet_path": "/absolute/path/to/keys/relayer.json",
  "pool_id": "B9g6VbfTeJb2LERzWpFGYQMd1Pi93pzmA1v5XdDiUm98"
}
```

| Field | Description |
|-------|-------------|
| `rpc_url` | Solana RPC endpoint (use a paid RPC like Helius for reliability) |
| `program_id` | PoW protocol program address |
| `mint` | Token mint address |
| `wallet_path` | Absolute path to your miner keypair JSON |
| `relayer_wallet_path` | (Privacy miner only) Absolute path to relayer keypair |
| `pool_id` | (Optional) Pool config PDA address |

---

## Standard CPU Miner

Pure TypeScript miner using Node.js `crypto.createHash('sha256')`. Expect ~3-5 MH/s.

```bash
npx ts-node standard-miner/continuous-miner.ts          # devnet
npx ts-node standard-miner/continuous-miner.ts --local   # localnet
```

- Single-threaded, mines up to 100M nonces per block
- Submits proofs directly to `pow_protocol.submitProof`
- Rewards go to the miner wallet

---

## Standard GPU Miner

Two-component architecture: a Rust binary for GPU hashing and a TypeScript orchestrator for Solana interaction.

### Build the Rust binary

```bash
cd gpu-miner
bash build.sh    # Interactive: detects CUDA/OpenCL, lets you choose backend
```

Manual build:

```bash
cargo build --release --features cuda     # NVIDIA
cargo build --release --features opencl   # AMD
cargo build --release                     # CPU fallback
```

### Run

```bash
npx ts-node standard-miner/continuous-gpu-miner.ts          # devnet
npx ts-node standard-miner/continuous-gpu-miner.ts --local   # localnet
```

The orchestrator fetches the current challenge + difficulty from on-chain, spawns the Rust binary with `--backend cuda`, parses the nonce from stdout, and submits the proof.

> **Note:** The Rust binary path is set in `continuous-gpu-miner.ts`. Update if needed.

---

## Privacy Miner (Arcium MPC)

Advanced miner that hides destination addresses and balances using Arcium MPC encryption. Uses versioned transactions with Address Lookup Tables (ALT) to fit within Solana's 1232-byte transaction limit.

### Wallets

The privacy miner uses 3 separate wallets for maximum anonymity:

| Wallet | Role | Needs SOL? |
|--------|------|------------|
| **Miner** | Earns rewards, holds encrypted balance | No (relayer pays fees) |
| **Relayer** | Pays all transaction fees | Yes (~0.5 SOL recommended) |
| **Claim** | Receives claimed tokens (set via menu) | Small amount for ATA creation |

### Setup (first time only)

#### 1. Create the Address Lookup Table

Required because privacy transactions have 25+ accounts and exceed the standard tx size limit.

```bash
npx ts-node scripts/create-alt.ts
```

This creates `alt-config.json` with the ALT address. The miner loads it automatically on startup.

#### 2. Initialize the privacy protocol (if needed)

If the program was freshly deployed, initialize the shared vaults:

```bash
npx ts-node scripts/initialize-privacy.ts
```

#### 3. Initialize computation definitions (if needed)

```bash
npx ts-node scripts/init-comp-defs.ts
```

### Run

```bash
npx ts-node privacy-miner/continuous-privacy-miner-arcium.ts          # devnet
npx ts-node privacy-miner/continuous-privacy-miner-arcium.ts --local   # localnet
```

### Interactive menu (press M during mining)

| Key | Action |
|-----|--------|
| **D** | Deposit SOL to encrypted balance (pays Arcium MPC fees) |
| **W** | Withdraw SOL from encrypted balance |
| **L** | List & claim pending rewards |
| **B** | Show balance status |
| **1** | Change miner wallet |
| **2** | Change relayer wallet |
| **C** | Set claim wallet keypair path |
| **N** | Change RPC endpoint |
| **S** | Stop mining |

Settings are persisted in SQLite (`data/claims.db`).

### How it works

1. GPU mines a valid nonce (same SHA256 proof-of-work as standard miner)
2. Generates a random secret and a fresh destination wallet
3. Encrypts the destination with Arcium MXE x25519 public key (RescueCipher)
4. Submits the encrypted claim via `pow-privacy` → Arcium MPC processes it
5. Claim rewards later → MPC verifies the secret, decrypts destination, transfers tokens

**Destinations are never visible on-chain** — only the Arcium MPC cluster can decrypt them.

### Claims database

All pending claims (secret, destination, computation offset) are stored in a local SQLite database at `data/claims.db`. This ensures claims survive restarts. The miner automatically retries failed claims on the next run.

---

## Architecture

```
┌─────────────────────┐     spawn      ┌──────────────────┐
│  TypeScript          │ ──────────────> │  Rust GPU Binary  │
│  Orchestrator        │ <───stdout──── │  (gpu-miner/)     │
│                      │    nonce        │  CUDA / OpenCL    │
└──────────┬──────────┘                 └──────────────────┘
           │
           │ Versioned TX (with ALT)
           ▼
┌──────────────────────┐     CPI       ┌──────────────────┐
│  pow-protocol        │ <──────────── │  pow-privacy      │
│  (mining + rewards)  │               │  (encrypted state)│
└──────────────────────┘               └────────┬─────────┘
                                                │
                                       Arcium MPC (cluster 456)
                                       x25519 encryption
                                       Off-chain computation
```

## Program IDs (Devnet)

| Program | Address |
|---------|---------|
| **pow-protocol** | `Ai9XrxSUmDLNCXkoeoqnYuzPgN9F2PeF9WtLq9GyqER` |
| **pow-privacy** | `DJB2PeDYBLczs5ZxmUrqpoEAuejgdP516J3fNsEXVY5f` |
| **Arcium** | `Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ` |
| **Token Mint** | `ACnhuoJn41PQQKfhuHYgAQXR3jPSg1i4zr59Qt68QAUR` |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to get MXE public key` | Arcium DKG not complete | Re-deploy with `arcium deploy --cluster-offset 456` |
| `Transaction too large` | Too many accounts (>1232 bytes) | Run `npx ts-node scripts/create-alt.ts` to create ALT |
| `AccountNotInitialized` (shared vaults) | Protocol not initialized | Run `npx ts-node scripts/initialize-privacy.ts` |
| `InvalidProgramId` (token_program) | IDL mismatch | Re-fetch IDL: `anchor idl fetch <program> --provider.cluster devnet` |

## License

MIT
