//! OpenCL Mining Backend (TODO)

use crate::miner::MinerBackend;
use anyhow::{Result, anyhow};

pub struct OpenClMiner;

impl OpenClMiner {
    pub fn new(_device_id: usize) -> Result<Self> {
        Err(anyhow!("OpenCL support not yet implemented"))
    }
}

impl MinerBackend for OpenClMiner {
    fn mine(&self, _challenge: &[u8; 32], _miner_pubkey: &[u8; 32], _block_number: u64, _target: u128, _max_nonce: u128) -> Option<u128> {
        None
    }

    fn name(&self) -> &str {
        "OpenCL (not implemented)"
    }
}
