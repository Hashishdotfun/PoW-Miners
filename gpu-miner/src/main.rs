//! Mineur PoW haute performance pour Solana
//! Supporte CPU, CUDA et OpenCL

use clap::Parser;
use log::{info, warn, error};
use std::time::Instant;

mod config;
mod miner;
mod pow;

#[cfg(feature = "cuda")]
mod cuda_miner;

#[cfg(feature = "opencl")]
mod opencl_miner;

use miner::MinerBackend;

#[derive(Parser)]
#[command(name = "pow-miner")]
#[command(about = "High-performance PoW miner for Solana", long_about = None)]
struct Cli {
    /// Backend à utiliser: auto, cpu, cuda, opencl
    #[arg(short, long, default_value = "auto")]
    backend: String,

    /// Nombre de threads CPU (si backend=cpu)
    #[arg(short, long)]
    threads: Option<usize>,

    /// ID du device GPU (si backend=cuda/opencl)
    #[arg(short, long, default_value = "0")]
    device: usize,

    /// Mode benchmark (ne se connecte pas au réseau)
    #[arg(long)]
    benchmark: bool,

    /// Difficulté pour le benchmark
    #[arg(long, default_value = "1000000")]
    difficulty: u128,

    /// Challenge (hex) pour le benchmark
    #[arg(long)]
    challenge: Option<String>,

    /// Block number pour le benchmark
    #[arg(long, default_value = "0")]
    block_number: u64,

    /// RPC URL
    #[arg(long, default_value = "http://localhost:8899")]
    rpc: String,

    /// Chemin vers le keypair du mineur
    #[arg(short, long, default_value = "~/.config/solana/id.json")]
    keypair: String,

    /// Program ID du protocole PoW
    #[arg(long)]
    program_id: Option<String>,

    /// Mint address du token
    #[arg(long)]
    mint: Option<String>,

    /// Miner public key (hex, 32 bytes) for benchmark mode
    #[arg(long)]
    miner_pubkey: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init();

    let cli = Cli::parse();

    info!("🚀 PoW Miner Starting...");
    info!("   Backend: {}", cli.backend);

    // Créer le mineur selon le backend
    let miner: Box<dyn MinerBackend> = match cli.backend.as_str() {
        "cpu" => {
            info!("   Using CPU backend");
            let threads = cli.threads.unwrap_or_else(num_cpus::get);
            info!("   Threads: {}", threads);
            Box::new(miner::CpuMiner::new(threads))
        }

        #[cfg(feature = "cuda")]
        "cuda" => {
            info!("   Using CUDA backend");
            match cuda_miner::CudaMiner::new(cli.device) {
                Ok(m) => {
                    info!("   ✓ CUDA initialized");
                    info!("   Device: {}", cli.device);
                    Box::new(m)
                }
                Err(e) => {
                    error!("   ✗ CUDA init failed: {}", e);
                    warn!("   Falling back to CPU");
                    Box::new(miner::CpuMiner::new(num_cpus::get()))
                }
            }
        }

        #[cfg(feature = "opencl")]
        "opencl" => {
            info!("   Using OpenCL backend");
            match opencl_miner::OpenClMiner::new(cli.device) {
                Ok(m) => {
                    info!("   ✓ OpenCL initialized");
                    Box::new(m)
                }
                Err(e) => {
                    error!("   ✗ OpenCL init failed: {}", e);
                    warn!("   Falling back to CPU");
                    Box::new(miner::CpuMiner::new(num_cpus::get()))
                }
            }
        }

        "auto" | _ => {
            info!("   Auto-detecting best backend...");

            // Try CUDA first
            #[cfg(feature = "cuda")]
            {
                if let Ok(m) = cuda_miner::CudaMiner::new(cli.device) {
                    info!("   ✓ Using CUDA");
                    Box::new(m) as Box<dyn MinerBackend>
                } else {
                    // Try OpenCL or fall back to CPU
                    #[cfg(feature = "opencl")]
                    {
                        if let Ok(m) = opencl_miner::OpenClMiner::new(cli.device) {
                            info!("   ✓ Using OpenCL");
                            Box::new(m) as Box<dyn MinerBackend>
                        } else {
                            info!("   Using CPU (no GPU detected)");
                            Box::new(miner::CpuMiner::new(num_cpus::get()))
                        }
                    }
                    #[cfg(not(feature = "opencl"))]
                    {
                        info!("   Using CPU (no GPU detected)");
                        Box::new(miner::CpuMiner::new(num_cpus::get()))
                    }
                }
            }

            // No CUDA feature - try OpenCL or CPU
            #[cfg(not(feature = "cuda"))]
            {
                #[cfg(feature = "opencl")]
                {
                    if let Ok(m) = opencl_miner::OpenClMiner::new(cli.device) {
                        info!("   ✓ Using OpenCL");
                        Box::new(m) as Box<dyn MinerBackend>
                    } else {
                        info!("   Using CPU (no GPU detected)");
                        Box::new(miner::CpuMiner::new(num_cpus::get()))
                    }
                }
                #[cfg(not(feature = "opencl"))]
                {
                    info!("   Using CPU (no GPU detected)");
                    Box::new(miner::CpuMiner::new(num_cpus::get()))
                }
            }
        }
    };

    // Mode benchmark
    if cli.benchmark {
        return run_benchmark(miner, cli.difficulty, cli.challenge, cli.block_number, cli.miner_pubkey).await;
    }

    // Mode mining normal
    run_miner(miner, &cli).await
}

async fn run_benchmark(
    miner: Box<dyn MinerBackend>,
    difficulty: u128,
    challenge_hex: Option<String>,
    block_number: u64,
    miner_pubkey_hex: Option<String>,
) -> anyhow::Result<()> {
    info!("\n╔══════════════════════════════════════════════════════════════╗");
    info!("║                    BENCHMARK MODE                            ║");
    info!("╚══════════════════════════════════════════════════════════════╝\n");

    // Parse challenge from hex or use default
    let challenge = if let Some(hex) = challenge_hex {
        let hex = hex.trim_start_matches("0x");
        let bytes = hex::decode(hex)
            .map_err(|e| anyhow::anyhow!("Invalid challenge hex: {}", e))?;
        if bytes.len() != 32 {
            anyhow::bail!("Challenge must be 32 bytes, got {}", bytes.len());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr
    } else {
        [0u8; 32]
    };

    // Parse miner pubkey from hex or use default
    let miner_pubkey = if let Some(hex) = miner_pubkey_hex {
        let hex = hex.trim_start_matches("0x");
        let bytes = hex::decode(hex)
            .map_err(|e| anyhow::anyhow!("Invalid miner_pubkey hex: {}", e))?;
        if bytes.len() != 32 {
            anyhow::bail!("Miner pubkey must be 32 bytes, got {}", bytes.len());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr
    } else {
        [0u8; 32] // Default pubkey for testing
    };

    let target = u128::MAX / difficulty;

    info!("Difficulty: {}", difficulty);
    info!("Block number: {}", block_number);
    info!("Challenge: {}", hex::encode(&challenge[..8]));
    info!("Miner: {}", hex::encode(&miner_pubkey[..8]));
    info!("Target: {:032x}", target);
    info!("\n⛏️  Mining...\n");

    let start = Instant::now();

    match miner.mine(&challenge, &miner_pubkey, block_number, target, u128::MAX) {
        Some(nonce) => {
            let elapsed = start.elapsed();
            let hashrate = (nonce as f64) / elapsed.as_secs_f64();

            info!("✓ Nonce found: {}", nonce);
            info!("  Time: {:?}", elapsed);
            info!("  Iterations: {}", nonce);
            info!("  Hashrate: {:.2} MH/s", hashrate / 1_000_000.0);

            // Verify
            let hash = pow::compute_hash(&challenge, &miner_pubkey, nonce, block_number);
            let hash_value = u128::from_le_bytes(hash[..16].try_into().unwrap());
            info!("  Hash: {:032x}", hash_value);
            info!("  Valid: {}", hash_value < target);
        }
        None => {
            info!("✗ No nonce found (reached limit)");
        }
    }

    Ok(())
}

async fn run_miner(
    _miner: Box<dyn MinerBackend>,
    _cli: &Cli,
) -> anyhow::Result<()> {
    anyhow::bail!("Mining mode is not yet implemented. Use --benchmark mode or use the TypeScript continuous-gpu-miner.ts script.");
}
