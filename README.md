# PoW Solana Miner

Mining software for the PoW Solana protocol. Supports CPU, GPU (CUDA/OpenCL), and privacy-preserving mining with Arcium MPC.

## Directory Structure

```
pow-miner/
├── gpu-miner/          # Rust GPU miner (CUDA/OpenCL)
│   ├── src/            # Miner source code
│   ├── kernels/        # CUDA/OpenCL kernels
│   ├── build.sh        # Interactive build script
│   └── Cargo.toml
├── privacy-miner/      # Privacy mining with Arcium MPC (TypeScript)
│   ├── continuous-privacy-miner-arcium.ts
│   ├── claims-db.ts
│   ├── miner-balance-manager.ts
│   └── check-miner-balance.ts
├── standard-miner/     # Standard miners (TypeScript)
│   ├── continuous-miner.ts         # CPU miner (pure Node.js SHA256)
│   └── continuous-gpu-miner.ts     # GPU orchestrator (calls Rust binary)
└── target/idl/         # Anchor IDL files (copy from PoWSolana)
```

## Prerequisites

- Node.js 18+
- A Solana keypair file (JSON format)
- The IDL files in `target/idl/` (copy from the PoWSolana project)
- For GPU mining: Rust 1.75+ and CUDA Toolkit 12+ (NVIDIA) or OpenCL SDK (AMD)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Copy IDL files

```bash
mkdir -p target/idl
cp ../PoWSolana/target/idl/*.json target/idl/
```

### 3. Create your wallet

If you don't already have one:

```bash
solana-keygen new -o ~/.config/solana/miner.json
```

Fund it with SOL for transaction fees:

```bash
# Devnet
solana airdrop 2 --keypair ~/.config/solana/miner.json --url devnet

# Mainnet: transfer SOL from another wallet
```

### 4. Create config file

Copy the example and fill in your values:

```bash
cp miner-config-devnet.example.json miner-config-devnet.json
```

Edit `miner-config-devnet.json`:

```json
{
  "rpc_url": "https://api.devnet.solana.com",
  "program_id": "6DEmqXKEokfBz2wiREVthwbkDECvrWorkJNd48duatL2",
  "mint": "8MFYkW8Mx4pVm9pAKj15iigDgQ2ZCXXeoRzRHp2x3CEs",
  "wallet_path": "/absolute/path/to/your/wallet.json",
  "relayer_wallet_path": "/absolute/path/to/your/relayer.json"
}
```

| Field | Description |
|-------|-------------|
| `rpc_url` | Solana RPC endpoint |
| `program_id` | PoW protocol program address |
| `mint` | Token mint address |
| `wallet_path` | Absolute path to your miner keypair JSON |
| `relayer_wallet_path` | (Privacy miner only) Absolute path to relayer keypair |

For localnet, create `miner-config.json` with `"rpc_url": "http://localhost:8899"`.

---

## CPU Miner

Pure TypeScript, uses Node.js `crypto.createHash('sha256')` in a single-threaded loop. Expect a few MH/s.

```bash
# Devnet (default)
npx ts-node standard-miner/continuous-miner.ts

# Localnet
npx ts-node standard-miner/continuous-miner.ts --local
```

- Mines up to 100M nonces per block
- Submits proofs directly to `pow_protocol.submitProof`
- Rewards go to the wallet specified in config

---

## GPU Miner

Two components: a Rust binary for GPU computation and a TypeScript orchestrator for Solana interaction.

### Build the Rust binary

```bash
cd gpu-miner
bash build.sh
```

The interactive script detects CUDA/OpenCL and lets you choose:
1. CPU only
2. CPU + CUDA (NVIDIA)
3. CPU + OpenCL (AMD)
4. All backends

Or build manually:

```bash
# CUDA
cargo build --release --features cuda

# OpenCL
cargo build --release --features opencl

# CPU only (default)
cargo build --release
```

### Run the GPU orchestrator

```bash
# Devnet (default)
npx ts-node standard-miner/continuous-gpu-miner.ts

# Localnet
npx ts-node standard-miner/continuous-gpu-miner.ts --local
```

The orchestrator fetches challenge + difficulty from on-chain, spawns the Rust binary with `--backend cuda`, parses the nonce from stdout, and submits the proof.

> **Note:** The Rust binary path is hardcoded in `continuous-gpu-miner.ts` (line 45). Update it if your binary is at a different location.

---

## Privacy Miner (Arcium MPC)

Advanced miner that hides your identity and balance using Arcium MPC encryption.

### Wallets

The privacy miner uses 3 separate wallets for anonymity:

| Wallet | Role | Needs SOL? |
|--------|------|------------|
| **Miner** | Earns rewards, holds encrypted balance | No (relayer pays) |
| **Relayer** | Pays transaction fees | Yes |
| **Claim** | Receives claimed tokens (set via menu) | Small amount for ATA creation |

### Run

```bash
# Devnet (default)
npx ts-node privacy-miner/continuous-privacy-miner-arcium.ts

# Localnet
npx ts-node privacy-miner/continuous-privacy-miner-arcium.ts --local
```

### Interactive menu (press M)

| Key | Action |
|-----|--------|
| D | Deposit SOL to encrypted balance |
| W | Withdraw SOL from encrypted balance |
| L | List & claim pending rewards |
| B | Show balance status |
| 1 | Change miner wallet |
| 2 | Change relayer wallet |
| C | Set claim wallet keypair path |
| N | Change RPC endpoint |
| S | Stop mining |

Wallet and RPC changes are persisted in SQLite (`data/claims.db`).

### How it works

1. GPU mines a valid nonce (same as standard miner)
2. Generates a random secret + destination wallet
3. Encrypts destination with Arcium MXE x25519 key (RescueCipher)
4. Submits encrypted claim via `pow-privacy` program -> Arcium MPC stores it
5. Later, claim rewards -> MPC verifies secret, decrypts destination, transfers tokens

Destinations are **never** visible on-chain.

---

## Architecture

```
┌─────────────────┐     spawn      ┌──────────────────┐
│  TS Orchestrator │ ──────────────> │  Rust GPU Binary  │
│  (standard-miner │ <───stdout──── │  (gpu-miner)      │
│   or privacy)    │    nonce        │  CUDA / OpenCL    │
└────────┬────────┘                 └──────────────────┘
         │
         │ submitProof / storeClaim
         ▼
┌─────────────────┐     CPI        ┌──────────────────┐
│  pow-protocol    │ <────────────  │  pow-privacy      │
│  (on-chain)      │                │  + Arcium MPC     │
└─────────────────┘                └──────────────────┘
```

## Program IDs

| Program | Address |
|---------|---------|
| **pow-protocol** | `6DEmqXKEokfBz2wiREVthwbkDECvrWorkJNd48duatL2` |
| **pow-privacy** | `HHTo8FEGs8J7VfCD5yDg3ifoKozSaY2cbLfC2U418XjP` |

## License

MIT
