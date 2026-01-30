//! CUDA Mining Backend

#[cfg(feature = "cuda")]
use cudarc::driver::*;
#[cfg(feature = "cuda")]
use std::sync::Arc;
use crate::miner::MinerBackend;
use anyhow::Result;
#[cfg(not(feature = "cuda"))]
use anyhow::anyhow;

#[cfg(feature = "cuda")]
pub struct CudaMiner {
    device: Arc<CudaDevice>,
    threads_per_block: usize,
    num_blocks: usize,
}

#[cfg(feature = "cuda")]
impl CudaMiner {
    pub fn new(device_id: usize) -> Result<Self> {
        // Get device
        let device = CudaDevice::new(device_id)?;

        // Load PTX module
        let ptx = include_str!("../kernels/sha256_mining.ptx");
        device.load_ptx(ptx.into(), "sha256_mining", &["mine_block"])?;

        // Default kernel configuration
        let threads_per_block = 256;
        let num_blocks = 1024;

        Ok(Self {
            device,
            threads_per_block,
            num_blocks,
        })
    }
    
    pub fn with_config(device_id: usize, threads_per_block: usize, num_blocks: usize) -> Result<Self> {
        let mut miner = Self::new(device_id)?;
        miner.threads_per_block = threads_per_block;
        miner.num_blocks = num_blocks;
        Ok(miner)
    }
}

#[cfg(feature = "cuda")]
impl MinerBackend for CudaMiner {
    fn mine(&self, challenge: &[u8; 32], miner_pubkey: &[u8; 32], block_number: u64, target: u128, max_nonce: u128) -> Option<u128> {
        // Pour l'instant, limiter à u64::MAX pour la partie GPU
        // TODO: Implémenter u128 dans CUDA kernel
        let max_nonce_u64 = if max_nonce > u64::MAX as u128 {
            u64::MAX
        } else {
            max_nonce as u64
        };

        // Calculate nonce count per launch
        let nonce_count = (self.threads_per_block * self.num_blocks) as u64;

        // Allocate device memory
        let d_challenge = self.device.htod_copy(challenge.to_vec()).ok()?;
        let d_miner_pubkey = self.device.htod_copy(miner_pubkey.to_vec()).ok()?;
        // Convert target to 32-byte little-endian array (matching Rust CPU comparison)
        let target_bytes: [u8; 16] = target.to_le_bytes();
        let mut target_full: Vec<u8> = vec![0u8; 32];
        target_full[..16].copy_from_slice(&target_bytes);
        let d_target = self.device.htod_copy(target_full).ok()?;
        let d_result = self.device.alloc_zeros::<u64>(1).ok()?;
        let d_found = self.device.alloc_zeros::<i32>(1).ok()?;

        // Mine in batches
        let mut start_nonce = 0u64;

        while start_nonce < max_nonce_u64 {
            let current_nonce_count = (max_nonce_u64 - start_nonce).min(nonce_count);

            // Launch kernel
            let cfg = LaunchConfig {
                grid_dim: (self.num_blocks as u32, 1, 1),
                block_dim: (self.threads_per_block as u32, 1, 1),
                shared_mem_bytes: 0,
            };

            let kernel = self.device.get_func("sha256_mining", "mine_block")?;
            let params = (
                &d_challenge,
                &d_miner_pubkey,
                block_number,
                start_nonce,
                current_nonce_count,
                &d_target,
                &d_result,
                &d_found,
            );

            unsafe {
                kernel.launch(cfg, params).ok()?;
            }

            // Check if found
            let found = self.device.dtoh_sync_copy(&d_found).ok()?;
            if found[0] == 1 {
                let nonce = self.device.dtoh_sync_copy(&d_result).ok()?;
                return Some(nonce[0] as u128);
            }

            start_nonce += current_nonce_count;
        }

        None
    }

    fn name(&self) -> &str {
        "CUDA"
    }
}

// Version simplifiée sans cudarc (pour compilation sans CUDA)
#[cfg(not(feature = "cuda"))]
pub struct CudaMiner;

#[cfg(not(feature = "cuda"))]
impl CudaMiner {
    pub fn new(_device_id: usize) -> Result<Self> {
        Err(anyhow!("CUDA support not compiled. Build with --features cuda"))
    }
}

#[cfg(not(feature = "cuda"))]
impl MinerBackend for CudaMiner {
    fn mine(&self, _challenge: &[u8; 32], _miner_pubkey: &[u8; 32], _block_number: u64, _target: u128, _max_nonce: u128) -> Option<u128> {
        None
    }

    fn name(&self) -> &str {
        "CUDA (disabled)"
    }
}
