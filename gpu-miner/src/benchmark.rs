//! Benchmark pour comparer les performances CPU vs GPU

use std::time::Instant;

mod config;
mod miner;
mod pow;

#[cfg(feature = "cuda")]
mod cuda_miner;

use miner::MinerBackend;

fn main() {
    env_logger::init();
    
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║            POW MINER - BENCHMARK COMPLET                     ║");
    println!("╚══════════════════════════════════════════════════════════════╝\n");
    
    let challenge = [0u8; 32];
    let miner_pubkey = [1u8; 32]; // Dummy miner pubkey for benchmark
    let difficulties = vec![
        ("Très facile", 1_000),
        ("Facile", 10_000),
        ("Moyen", 100_000),
        ("Difficile", 1_000_000),
        ("Très difficile", 10_000_000),
    ];

    // Benchmark CPU
    println!("📊 CPU Mining (multi-threaded)\n");
    println!("Threads: {}\n", num_cpus::get());

    let cpu_miner = miner::CpuMiner::new(num_cpus::get());

    let block_number = 0; // Numéro de bloc fictif pour le benchmark

    for (name, diff) in &difficulties {
        let target = u128::MAX / diff;

        print!("  {} (diff: {})... ", name, diff);

        let start = Instant::now();
        match cpu_miner.mine(&challenge, &miner_pubkey, block_number, target, u128::MAX) {
            Some(nonce) => {
                let elapsed = start.elapsed();
                let hashrate = (nonce as f64) / elapsed.as_secs_f64();
                println!("✓ {:?} ({:.2} MH/s)", elapsed, hashrate / 1_000_000.0);
            }
            None => {
                println!("✗ Not found");
            }
        }
    }
    
    // Benchmark CUDA
    #[cfg(feature = "cuda")]
    {
        println!("\n📊 CUDA Mining\n");

        match cuda_miner::CudaMiner::new(0) {
            Ok(cuda_miner) => {
                for (name, diff) in &difficulties {
                    let target = u128::MAX / diff;

                    print!("  {} (diff: {})... ", name, diff);

                    let start = Instant::now();
                    match cuda_miner.mine(&challenge, &miner_pubkey, block_number, target, u128::MAX) {
                        Some(nonce) => {
                            let elapsed = start.elapsed();
                            let hashrate = (nonce as f64) / elapsed.as_secs_f64();
                            println!("✓ {:?} ({:.2} MH/s)", elapsed, hashrate / 1_000_000.0);
                        }
                        None => {
                            println!("✗ Not found");
                        }
                    }
                }
            }
            Err(e) => {
                println!("⚠️  CUDA not available: {}", e);
            }
        }
    }
    
    #[cfg(not(feature = "cuda"))]
    {
        println!("\n⚠️  CUDA not compiled (use --features cuda)");
    }
    
    println!("\n✅ Benchmark terminé!\n");
}
