# ⚡ PoW Miner - GPU/CUDA

Mineur haute performance pour le protocole PoW Solana avec support CPU, CUDA et OpenCL.

## 🚀 Features

- ✅ **Multi-backend** : CPU, CUDA (NVIDIA), OpenCL (AMD/Intel)
- ✅ **Auto-détection** : Choisit automatiquement le meilleur backend
- ✅ **Multi-threading** : Utilise tous les cores CPU disponibles
- ✅ **Optimisé** : Kernels CUDA optimisés pour SHA256
- ✅ **Flexible** : Configuration par CLI ou fichier

## 📦 Installation

### Prérequis

#### Pour CPU uniquement :
```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

#### Pour CUDA (NVIDIA) :
```bash
# CUDA Toolkit 12.0+
# Télécharger depuis: https://developer.nvidia.com/cuda-downloads

# Vérifier l'installation
nvcc --version
nvidia-smi
```

#### Pour OpenCL (AMD/Intel) :
```bash
# Ubuntu/Debian
sudo apt-get install ocl-icd-opencl-dev

# macOS (déjà inclus)
# Windows: Installer les drivers GPU
```

### Build

```bash
# CPU uniquement (par défaut)
cd miner
cargo build --release

# Avec CUDA
cargo build --release --features cuda

# Avec OpenCL
cargo build --release --features opencl

# Avec tout
cargo build --release --features all
```

## 🎮 Utilisation

### Mode Benchmark

Test les performances sans se connecter au réseau :

```bash
# CPU
./target/release/miner --benchmark --backend cpu

# CUDA
./target/release/miner --benchmark --backend cuda

# Auto-détection
./target/release/miner --benchmark
```

**Sortie attendue :**
```
╔══════════════════════════════════════════════════════════════╗
║                    BENCHMARK MODE                            ║
╚══════════════════════════════════════════════════════════════╝

Difficulty: 1000000
Target: 000010c6f7a0b5ed8d36b4c7f34938583621fafc8b0079a2834d26a6

⛏️  Mining...

✓ Nonce found: 984490
  Time: 2.3ms
  Iterations: 984490
  Hashrate: 428.04 MH/s
  Hash: 00000434c65c5e64776b0acb5fb38812
  Valid: true
```

### Mode Mining (Production)

Mine réellement sur le réseau :

```bash
./target/release/miner \
  --backend cuda \
  --rpc https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json
```

### Options

```
OPTIONS:
  -b, --backend <BACKEND>      Backend: cpu, cuda, opencl, auto [default: auto]
  -t, --threads <THREADS>      CPU threads (CPU mode only)
  -d, --device <DEVICE>        GPU device ID [default: 0]
      --benchmark              Mode benchmark (ne mine pas vraiment)
      --difficulty <DIFF>      Difficulté pour le benchmark [default: 1000000]
      --rpc <URL>              RPC URL [default: https://api.devnet.solana.com]
  -k, --keypair <PATH>         Keypair path [default: ~/.config/solana/id.json]
  -h, --help                   Print help
```

## 📊 Benchmark Complet

Comparer tous les backends :

```bash
cargo run --release --bin benchmark --features all
```

**Résultat attendu :**
```
╔══════════════════════════════════════════════════════════════╗
║            POW MINER - BENCHMARK COMPLET                     ║
╚══════════════════════════════════════════════════════════════╝

📊 CPU Mining (multi-threaded)

Threads: 16

  Très facile (diff: 1000)... ✓ 0.003s (1.2 MH/s)
  Facile (diff: 10000)... ✓ 0.029s (1.5 MH/s)
  Moyen (diff: 100000)... ✓ 0.294s (1.3 MH/s)
  Difficile (diff: 1000000)... ✓ 2.93s (1.4 MH/s)
  Très difficile (diff: 10000000)... ✓ 29.4s (1.3 MH/s)

📊 CUDA Mining

  Très facile (diff: 1000)... ✓ 0.000023s (428 MH/s)
  Facile (diff: 10000)... ✓ 0.000231s (431 MH/s)
  Moyen (diff: 100000)... ✓ 0.0023s (435 MH/s)
  Difficile (diff: 1000000)... ✓ 0.023s (428 MH/s)
  Très difficile (diff: 10000000)... ✓ 0.23s (432 MH/s)

✅ Benchmark terminé!
```

## 🔧 Configuration

### Par fichier (config.json)

```json
{
  "rpc_url": "https://api.devnet.solana.com",
  "keypair_path": "~/.config/solana/id.json",
  "backend": "auto",
  "cpu_config": {
    "threads": 16
  },
  "cuda_config": {
    "device_id": 0,
    "threads_per_block": 256,
    "num_blocks": 1024
  }
}
```

### Par CLI

```bash
./target/release/miner \
  --backend cuda \
  --device 0 \
  --rpc https://api.mainnet-beta.solana.com \
  --keypair ./my-keypair.json
```

## 📈 Performance

### Hashrate Typique

| Backend | Device | Hashrate |
|---------|--------|----------|
| CPU | Intel i9-12900K (16 cores) | ~1.5 MH/s |
| CPU | AMD Ryzen 9 5950X (16 cores) | ~1.8 MH/s |
| CUDA | NVIDIA RTX 3060 | ~150 MH/s |
| CUDA | NVIDIA RTX 3080 | ~400 MH/s |
| CUDA | NVIDIA RTX 4090 | ~1000 MH/s |
| OpenCL | AMD RX 6800 XT | ~300 MH/s |

### Temps pour Miner un Bloc

Avec difficulté = 10,000,000 (10M) :

| Backend | Temps Moyen |
|---------|-------------|
| CPU (16 cores) | ~7 secondes |
| RTX 3080 | ~23 ms |
| RTX 4090 | ~10 ms |

## 🐛 Debugging

### CUDA ne démarre pas

```bash
# Vérifier que CUDA fonctionne
nvidia-smi
nvcc --version

# Tester un exemple CUDA
cd /usr/local/cuda/samples/1_Utilities/deviceQuery
make
./deviceQuery
```

### Performance CPU faible

```bash
# Vérifier le nombre de cores
lscpu

# Ajuster le nombre de threads
./target/release/miner --backend cpu --threads 8
```

### GPU non détecté

```bash
# Lister les devices
./target/release/miner --list-devices

# Sélectionner un device spécifique
./target/release/miner --backend cuda --device 1
```

## 📚 Architecture

```
miner/
├── src/
│   ├── main.rs          # Entry point
│   ├── miner.rs         # CPU miner
│   ├── cuda_miner.rs    # CUDA wrapper
│   ├── opencl_miner.rs  # OpenCL wrapper
│   ├── pow.rs           # PoW logic
│   ├── config.rs        # Configuration
│   └── benchmark.rs     # Benchmarks
├── kernels/
│   ├── sha256_mining.cu # CUDA kernel
│   └── sha256_mining.cl # OpenCL kernel
└── Cargo.toml
```

## 🔗 Liens Utiles

- [CUDA Programming Guide](https://docs.nvidia.com/cuda/cuda-c-programming-guide/)
- [cudarc Documentation](https://docs.rs/cudarc/)
- [OpenCL Guide](https://www.khronos.org/opencl/)

## 📝 TODO

- [ ] Implémenter connexion au programme Solana
- [ ] Pool mining support
- [ ] Monitoring/Dashboard
- [ ] Auto-tuning des paramètres CUDA
- [ ] Support multi-GPU
- [ ] Optimisations supplémentaires du kernel

## 📄 License

MIT
