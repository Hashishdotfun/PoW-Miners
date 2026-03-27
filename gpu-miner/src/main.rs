//! Mineur PoW haute performance pour Solana
//! Supporte CPU, CUDA et OpenCL

use clap::Parser;
use log::{info, warn, error};
use std::time::{Duration, Instant};

mod config;
mod miner;
mod pow;
mod solana_client;

#[cfg(feature = "cuda")]
mod cuda_miner;

#[cfg(feature = "opencl")]
mod opencl_miner;

use miner::MinerBackend;
use solana_client::SolanaClient;

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

    /// CUDA threads par block
    #[arg(long)]
    cuda_threads_per_block: Option<usize>,

    /// CUDA nombre de blocks par launch
    #[arg(long)]
    cuda_num_blocks: Option<usize>,

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

    /// Pool ID: 0 = normal (open), 1 = seeker (requires TEE attestation)
    #[arg(long, default_value = "0")]
    pool_id: u8,

    /// Poll interval in ms to check for new challenges
    #[arg(long, default_value = "1500")]
    poll_interval: u64,
}

#[cfg(feature = "cuda")]
fn build_cuda_miner(cli: &Cli) -> anyhow::Result<cuda_miner::CudaMiner> {
    match (cli.cuda_threads_per_block, cli.cuda_num_blocks) {
        (Some(threads_per_block), Some(num_blocks)) => {
            cuda_miner::CudaMiner::with_config(cli.device, threads_per_block, num_blocks)
        }
        (Some(threads_per_block), None) => {
            cuda_miner::CudaMiner::with_config(cli.device, threads_per_block, 1024)
        }
        (None, Some(num_blocks)) => {
            cuda_miner::CudaMiner::with_config(cli.device, 256, num_blocks)
        }
        (None, None) => cuda_miner::CudaMiner::new(cli.device),
    }
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
            match build_cuda_miner(&cli) {
                Ok(m) => {
                    info!("   ✓ CUDA initialized");
                    info!("   Device: {}", cli.device);
                    info!("   Threads/block: {}", m.threads_per_block());
                    info!("   Num blocks: {}", m.num_blocks());
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
                if let Ok(m) = build_cuda_miner(&cli) {
                    info!("   ✓ Using CUDA");
                    info!("   Threads/block: {}", m.threads_per_block());
                    info!("   Num blocks: {}", m.num_blocks());
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
    info!("Backend: {}", miner.name());
    info!("Challenge: {}", hex::encode(&challenge[..8]));
    info!("Miner: {}", hex::encode(&miner_pubkey[..8]));
    info!("Target: {:032x}", target);
    info!("\n⛏️  Mining...\n");

    let start = Instant::now();
    let mut last_report_at = Instant::now();
    let mut last_reported_hashes = 0u128;
    let mut progress = |hashes_checked: u128| {
        let now = Instant::now();
        let delta = now.duration_since(last_report_at);
        if delta.as_millis() < 500 {
            return;
        }

        let elapsed_secs = start.elapsed().as_secs_f64();
        if elapsed_secs <= 0.0 {
            return;
        }

        let delta_hashes = hashes_checked.saturating_sub(last_reported_hashes) as f64;
        let live_hashrate = if delta.as_secs_f64() > 0.0 {
            delta_hashes / delta.as_secs_f64()
        } else {
            0.0
        };
        let avg_hashrate = hashes_checked as f64 / elapsed_secs;

        info!(
            "Progress: {} hashes | Live: {:.2} MH/s | Avg: {:.2} MH/s",
            hashes_checked,
            live_hashrate / 1_000_000.0,
            avg_hashrate / 1_000_000.0
        );

        last_report_at = now;
        last_reported_hashes = hashes_checked;
    };

    match miner.mine_with_progress(
        &challenge,
        &miner_pubkey,
        block_number,
        target,
        u128::MAX,
        &mut progress,
    ) {
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
    miner: Box<dyn MinerBackend>,
    cli: &Cli,
) -> anyhow::Result<()> {
    // Validate required args
    let program_id = cli.program_id.as_ref()
        .ok_or_else(|| anyhow::anyhow!("--program-id is required for mining mode"))?;
    let mint = cli.mint.as_ref()
        .ok_or_else(|| anyhow::anyhow!("--mint is required for mining mode"))?;

    // Expand ~ in keypair path
    let keypair_path = shellexpand::tilde(&cli.keypair).to_string();

    info!("\n======================================================");
    info!("              PoW MINER - MINING MODE");
    info!("======================================================\n");
    info!("Backend: {}", miner.name());
    info!("RPC: {}", cli.rpc);
    info!("Pool: {} ({})", cli.pool_id, if cli.pool_id == 0 { "normal" } else { "seeker" });

    let client = SolanaClient::new(
        &cli.rpc,
        &keypair_path,
        program_id,
        mint,
        cli.pool_id,
    )?;

    let miner_pubkey_bytes: [u8; 32] = client.miner_pubkey().to_bytes();

    // Check balance
    let balance = client.get_balance()?;
    info!("Balance: {:.4} SOL", balance as f64 / 1_000_000_000.0);
    if balance < 10_000_000 {
        anyhow::bail!("Insufficient balance ({} lamports). Need at least 0.01 SOL for fees.", balance);
    }

    let poll_interval = Duration::from_millis(cli.poll_interval);
    let mut blocks_found: u64 = 0;
    let mut last_challenge = [0u8; 32];

    info!("\nStarting mining loop...\n");

    loop {
        // Fetch current protocol state
        let state = match client.fetch_protocol_state() {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to fetch state: {}. Retrying...", e);
                std::thread::sleep(Duration::from_secs(3));
                continue;
            }
        };

        if state.is_paused {
            warn!("Protocol is paused. Waiting...");
            std::thread::sleep(Duration::from_secs(10));
            continue;
        }

        let challenge_changed = state.current_challenge != last_challenge;
        if challenge_changed {
            last_challenge = state.current_challenge;
            info!("--- Block #{} | Difficulty: {} | Challenge: {} ---",
                state.blocks_mined,
                state.difficulty,
                hex::encode(&state.current_challenge[..8]),
            );
        }

        let target = u128::MAX / state.difficulty;

        // Mine with progress reporting
        let start = Instant::now();
        let mut last_report_at = Instant::now();
        let mut last_reported_hashes = 0u128;
        let challenge = state.current_challenge;
        let blocks_mined = state.blocks_mined;

        // Use a batch approach: mine for a while, check if challenge changed, repeat
        let batch_max_nonce: u128 = 500_000_000; // 500M nonces per batch

        let mut progress = |hashes_checked: u128| {
            let now = Instant::now();
            let delta = now.duration_since(last_report_at);
            if delta.as_millis() < 2000 {
                return;
            }

            let delta_hashes = hashes_checked.saturating_sub(last_reported_hashes) as f64;
            let live_hashrate = if delta.as_secs_f64() > 0.0 {
                delta_hashes / delta.as_secs_f64()
            } else {
                0.0
            };

            info!(
                "  Mining... {} hashes | {:.2} MH/s",
                hashes_checked,
                live_hashrate / 1_000_000.0,
            );

            last_report_at = now;
            last_reported_hashes = hashes_checked;
        };

        match miner.mine_with_progress(
            &challenge,
            &miner_pubkey_bytes,
            blocks_mined,
            target,
            batch_max_nonce,
            &mut progress,
        ) {
            Some(nonce) => {
                let elapsed = start.elapsed();
                let hashrate = (nonce as f64) / elapsed.as_secs_f64().max(0.001);

                info!("FOUND nonce: {} ({:.2}s, {:.2} MH/s)",
                    nonce, elapsed.as_secs_f64(), hashrate / 1_000_000.0);

                // Verify locally before submitting
                if !pow::verify_nonce(&challenge, &miner_pubkey_bytes, nonce, blocks_mined, target) {
                    error!("Local verification failed! Skipping submission.");
                    continue;
                }

                // Submit proof
                match client.submit_proof(nonce) {
                    Ok(sig) => {
                        blocks_found += 1;
                        info!("Block submitted! tx: {}", sig);
                        info!("Total blocks found: {}", blocks_found);
                    }
                    Err(e) => {
                        warn!("Submit failed: {}. Block may have been stolen.", e);
                    }
                }

                // Small delay before fetching new challenge
                std::thread::sleep(Duration::from_millis(500));
            }
            None => {
                // No nonce found in this batch — check if challenge changed
                let new_state = client.fetch_protocol_state().ok();
                if let Some(ns) = &new_state {
                    if ns.current_challenge != challenge {
                        info!("Challenge changed (block stolen). Re-fetching...");
                        continue;
                    }
                }
                // Challenge didn't change, continue mining with higher nonces
                // For simplicity, we restart from 0 with the same challenge
                // (the hash space is large enough that collisions are negligible)
                std::thread::sleep(poll_interval);
            }
        }
    }
}
