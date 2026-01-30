//! Backends de mining

use crate::pow;
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Trait pour les différents backends de mining
pub trait MinerBackend: Send + Sync {
    /// Mine un bloc jusqu'à trouver un nonce valide ou atteindre max_nonce
    /// miner_pubkey est inclus dans le hash pour empêcher le vol de travail
    fn mine(&self, challenge: &[u8; 32], miner_pubkey: &[u8; 32], block_number: u64, target: u128, max_nonce: u128) -> Option<u128>;

    /// Nom du backend
    fn name(&self) -> &str;
}

// ============================================================================
// CPU MINER
// ============================================================================

pub struct CpuMiner {
    threads: usize,
}

impl CpuMiner {
    pub fn new(threads: usize) -> Self {
        Self { threads }
    }
}

impl MinerBackend for CpuMiner {
    fn mine(&self, challenge: &[u8; 32], miner_pubkey: &[u8; 32], block_number: u64, target: u128, max_nonce: u128) -> Option<u128> {
        let found = Arc::new(AtomicBool::new(false));
        let result = Arc::new(Mutex::new(0u128));
        let miner_pubkey = *miner_pubkey; // Copy for threads

        // Configurer rayon pour utiliser le bon nombre de threads
        rayon::ThreadPoolBuilder::new()
            .num_threads(self.threads)
            .build()
            .unwrap()
            .install(|| {
                // Diviser le travail en chunks
                let chunk_size = max_nonce / (self.threads as u128);

                (0..self.threads).into_par_iter().for_each(|thread_id| {
                    let start = thread_id as u128 * chunk_size;
                    let end = if thread_id == self.threads - 1 {
                        max_nonce
                    } else {
                        (thread_id as u128 + 1) * chunk_size
                    };

                    let mut nonce = start;
                    while nonce < end {
                        // Check si un autre thread a trouvé
                        if found.load(Ordering::Relaxed) {
                            break;
                        }

                        if pow::verify_nonce(challenge, &miner_pubkey, nonce, block_number, target) {
                            found.store(true, Ordering::Relaxed);
                            *result.lock().unwrap() = nonce;
                            break;
                        }

                        // Progress update every 100k hashes
                        if nonce % 100_000 == 0 && thread_id == 0 {
                            // log::debug!("Thread 0: {} hashes", nonce);
                        }

                        nonce += 1;
                    }
                });
            });

        if found.load(Ordering::Relaxed) {
            Some(*result.lock().unwrap())
        } else {
            None
        }
    }

    fn name(&self) -> &str {
        "CPU"
    }
}

// ============================================================================
// CPU MINER - Version simple (single thread)
// ============================================================================

pub struct SimpleCpuMiner;

impl MinerBackend for SimpleCpuMiner {
    fn mine(&self, challenge: &[u8; 32], miner_pubkey: &[u8; 32], block_number: u64, target: u128, max_nonce: u128) -> Option<u128> {
        let mut nonce = 0u128;
        while nonce < max_nonce {
            if pow::verify_nonce(challenge, miner_pubkey, nonce, block_number, target) {
                return Some(nonce);
            }
            nonce += 1;
        }
        None
    }

    fn name(&self) -> &str {
        "CPU (Simple)"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cpu_miner() {
        let miner = CpuMiner::new(4);
        let challenge = [0u8; 32];
        let miner_pubkey = [1u8; 32];
        let block_number = 100;
        let target = u128::MAX / 10_000;

        let result = miner.mine(&challenge, &miner_pubkey, block_number, target, 100_000);
        assert!(result.is_some(), "Should find a nonce");

        let nonce = result.unwrap();
        assert!(pow::verify_nonce(&challenge, &miner_pubkey, nonce, block_number, target));
    }

    #[test]
    fn test_simple_cpu_miner() {
        let miner = SimpleCpuMiner;
        let challenge = [0u8; 32];
        let miner_pubkey = [1u8; 32];
        let block_number = 100;
        let target = u128::MAX / 1_000;

        let result = miner.mine(&challenge, &miner_pubkey, block_number, target, 10_000);
        assert!(result.is_some());
    }
}
