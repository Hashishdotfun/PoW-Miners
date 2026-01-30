//! Configuration du mineur

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// URL du RPC Solana
    pub rpc_url: String,
    
    /// Chemin vers le keypair du mineur
    pub keypair_path: String,
    
    /// Backend de mining: cpu, cuda, opencl
    pub backend: MinerBackend,
    
    /// Configuration CPU
    pub cpu_config: CpuConfig,
    
    /// Configuration CUDA
    pub cuda_config: CudaConfig,
    
    /// Configuration OpenCL
    pub opencl_config: OpenClConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MinerBackend {
    Cpu,
    Cuda,
    OpenCl,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuConfig {
    /// Nombre de threads
    pub threads: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CudaConfig {
    /// ID du device CUDA
    pub device_id: usize,
    
    /// Threads par block
    pub threads_per_block: usize,
    
    /// Nombre de blocks
    pub num_blocks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenClConfig {
    /// ID du device OpenCL
    pub device_id: usize,
    
    /// Work group size
    pub work_group_size: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            rpc_url: "https://api.devnet.solana.com".to_string(),
            keypair_path: "~/.config/solana/id.json".to_string(),
            backend: MinerBackend::Auto,
            cpu_config: CpuConfig::default(),
            cuda_config: CudaConfig::default(),
            opencl_config: OpenClConfig::default(),
        }
    }
}

impl Default for CpuConfig {
    fn default() -> Self {
        Self {
            threads: num_cpus::get(),
        }
    }
}

impl Default for CudaConfig {
    fn default() -> Self {
        Self {
            device_id: 0,
            threads_per_block: 256,
            num_blocks: 1024,
        }
    }
}

impl Default for OpenClConfig {
    fn default() -> Self {
        Self {
            device_id: 0,
            work_group_size: 256,
        }
    }
}
