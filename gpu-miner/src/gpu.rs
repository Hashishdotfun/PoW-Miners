// =============================================================================
// GPU MINING - OpenCL
// =============================================================================
// Compatible: NVIDIA, AMD, Intel GPUs
// Cross-platform: Windows, Linux, macOS

use anyhow::{Context, Result, anyhow};
use log::{info, debug};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

#[cfg(feature = "gpu")]
use ocl::{Buffer, Device, Platform, ProQue, SpatialDims};

/// Kernel OpenCL pour SHA256 mining
#[cfg(feature = "gpu")]
const OPENCL_KERNEL: &str = r#"
// SHA256 Constants
__constant uint K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

// SHA256 helper functions
#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define EP1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define SIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

// Swap bytes for big-endian
#define SWAP32(x) (((x) >> 24) | (((x) >> 8) & 0x0000ff00) | (((x) << 8) & 0x00ff0000) | ((x) << 24))

void sha256_transform(uint* state, const uint* data) {
    uint a, b, c, d, e, f, g, h;
    uint w[64];
    uint t1, t2;

    // Prepare message schedule
    for (int i = 0; i < 16; i++) {
        w[i] = data[i];
    }
    for (int i = 16; i < 64; i++) {
        w[i] = SIG1(w[i-2]) + w[i-7] + SIG0(w[i-15]) + w[i-16];
    }

    // Initialize working variables
    a = state[0];
    b = state[1];
    c = state[2];
    d = state[3];
    e = state[4];
    f = state[5];
    g = state[6];
    h = state[7];

    // Main loop
    for (int i = 0; i < 64; i++) {
        t1 = h + EP1(e) + CH(e, f, g) + K[i] + w[i];
        t2 = EP0(a) + MAJ(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    // Add to state
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

// SHA256 for 40 bytes (32-byte challenge + 8-byte nonce)
void sha256_40bytes(const uchar* data, uchar* hash) {
    uint state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };

    uint block[16];
    
    // First 40 bytes of data (big-endian)
    for (int i = 0; i < 10; i++) {
        block[i] = ((uint)data[i*4] << 24) | ((uint)data[i*4+1] << 16) |
                   ((uint)data[i*4+2] << 8) | (uint)data[i*4+3];
    }
    
    // Padding: 0x80 after data
    block[10] = 0x80000000;
    
    // Zero padding
    for (int i = 11; i < 15; i++) {
        block[i] = 0;
    }
    
    // Length in bits (40 * 8 = 320 = 0x140)
    block[15] = 320;

    sha256_transform(state, block);

    // Output hash (big-endian)
    for (int i = 0; i < 8; i++) {
        hash[i*4] = (state[i] >> 24) & 0xff;
        hash[i*4+1] = (state[i] >> 16) & 0xff;
        hash[i*4+2] = (state[i] >> 8) & 0xff;
        hash[i*4+3] = state[i] & 0xff;
    }
}

// Compare hash with target (little-endian comparison of first 16 bytes)
bool is_valid_hash(const uchar* hash, __constant uchar* target) {
    // Compare as 128-bit little-endian integers
    for (int i = 15; i >= 0; i--) {
        if (hash[i] < target[i]) return true;
        if (hash[i] > target[i]) return false;
    }
    return false;
}

__kernel void mine(
    __constant uchar* challenge,     // 32 bytes
    __constant uchar* target,        // 16 bytes (lower 128 bits of target)
    ulong start_nonce,
    __global ulong* result_nonce,    // Output: valid nonce
    __global uchar* result_hash,     // Output: hash of valid nonce (32 bytes)
    __global uint* found             // Output: 1 if found
) {
    ulong gid = get_global_id(0);
    ulong nonce = start_nonce + gid;
    
    // Check if already found
    if (*found) return;
    
    // Prepare message: challenge (32 bytes) + nonce (8 bytes, little-endian)
    uchar message[40];
    for (int i = 0; i < 32; i++) {
        message[i] = challenge[i];
    }
    
    // Nonce in little-endian
    for (int i = 0; i < 8; i++) {
        message[32 + i] = (nonce >> (i * 8)) & 0xff;
    }
    
    // Compute SHA256
    uchar hash[32];
    sha256_40bytes(message, hash);
    
    // Check if valid
    if (is_valid_hash(hash, target)) {
        // Atomic set found flag
        if (atomic_cmpxchg(found, 0, 1) == 0) {
            *result_nonce = nonce;
            for (int i = 0; i < 32; i++) {
                result_hash[i] = hash[i];
            }
        }
    }
}
"#;

/// Détecte les GPUs disponibles
#[cfg(feature = "gpu")]
pub fn detect_gpu(device_index: usize) -> Result<String> {
    let platforms = Platform::list();
    if platforms.is_empty() {
        return Err(anyhow!("No OpenCL platforms found"));
    }

    let mut all_devices = Vec::new();
    for platform in platforms {
        let devices = Device::list_all(&platform)?;
        all_devices.extend(devices);
    }

    if all_devices.is_empty() {
        return Err(anyhow!("No OpenCL devices found"));
    }

    if device_index >= all_devices.len() {
        return Err(anyhow!("Device index {} out of range (max: {})", 
            device_index, all_devices.len() - 1));
    }

    let device = &all_devices[device_index];
    let name = device.name()?;
    
    Ok(name)
}

#[cfg(not(feature = "gpu"))]
pub fn detect_gpu(_device_index: usize) -> Result<String> {
    Err(anyhow!("GPU support not compiled. Rebuild with --features gpu"))
}

/// Liste tous les devices GPU
#[cfg(feature = "gpu")]
pub fn list_devices() -> Result<Vec<String>> {
    let platforms = Platform::list();
    let mut devices = Vec::new();

    for platform in platforms {
        let platform_name = platform.name()?;
        let platform_devices = Device::list_all(&platform)?;
        
        for device in platform_devices {
            let name = device.name()?;
            let vendor = device.vendor()?;
            let device_type = match device.info(ocl::enums::DeviceInfo::Type)? {
                ocl::enums::DeviceInfoResult::Type(t) => {
                    if t.contains(ocl::flags::DeviceType::GPU) {
                        "GPU"
                    } else if t.contains(ocl::flags::DeviceType::CPU) {
                        "CPU"
                    } else {
                        "Other"
                    }
                }
                _ => "Unknown"
            };
            
            devices.push(format!("{} - {} ({}) [{}]", name, vendor, device_type, platform_name));
        }
    }

    if devices.is_empty() {
        return Err(anyhow!("No OpenCL devices found"));
    }

    Ok(devices)
}

#[cfg(not(feature = "gpu"))]
pub fn list_devices() -> Result<Vec<String>> {
    Err(anyhow!("GPU support not compiled"))
}

/// Mine sur GPU
#[cfg(feature = "gpu")]
pub async fn mine(
    challenge: &[u8; 32],
    difficulty: u128,
    device_index: usize,
    hash_counter: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
) -> Result<Option<(u64, [u8; 32])>> {
    // Calculer le target
    let target = u128::MAX / difficulty;
    let target_bytes: [u8; 16] = target.to_le_bytes();

    // Trouver le device
    let platforms = Platform::list();
    let mut all_devices = Vec::new();
    for platform in &platforms {
        let devices = Device::list_all(platform)?;
        all_devices.extend(devices);
    }

    if device_index >= all_devices.len() {
        return Err(anyhow!("Device index out of range"));
    }

    let device = all_devices[device_index].clone();
    
    // Créer le programme OpenCL
    let pro_que = ProQue::builder()
        .device(device)
        .src(OPENCL_KERNEL)
        .dims(1024 * 256) // Work size: 256K threads per batch
        .build()?;

    // Créer les buffers
    let challenge_buf = Buffer::<u8>::builder()
        .queue(pro_que.queue().clone())
        .len(32)
        .copy_host_slice(challenge)
        .build()?;

    let target_buf = Buffer::<u8>::builder()
        .queue(pro_que.queue().clone())
        .len(16)
        .copy_host_slice(&target_bytes)
        .build()?;

    let result_nonce_buf = Buffer::<u64>::builder()
        .queue(pro_que.queue().clone())
        .len(1)
        .fill_val(0u64)
        .build()?;

    let result_hash_buf = Buffer::<u8>::builder()
        .queue(pro_que.queue().clone())
        .len(32)
        .fill_val(0u8)
        .build()?;

    let found_buf = Buffer::<u32>::builder()
        .queue(pro_que.queue().clone())
        .len(1)
        .fill_val(0u32)
        .build()?;

    // Mining loop
    let batch_size = pro_que.dims().to_len();
    let mut start_nonce: u64 = rand::random();

    while running.load(Ordering::Relaxed) {
        // Reset found flag
        found_buf.write(&[0u32]).enq()?;

        // Build and run kernel
        let kernel = pro_que.kernel_builder("mine")
            .arg(&challenge_buf)
            .arg(&target_buf)
            .arg(start_nonce)
            .arg(&result_nonce_buf)
            .arg(&result_hash_buf)
            .arg(&found_buf)
            .build()?;

        unsafe { kernel.enq()?; }
        pro_que.queue().finish()?;

        // Update counter
        hash_counter.fetch_add(batch_size as u64, Ordering::Relaxed);

        // Check if found
        let mut found = [0u32; 1];
        found_buf.read(&mut found).enq()?;

        if found[0] == 1 {
            let mut nonce = [0u64; 1];
            let mut hash = [0u8; 32];
            result_nonce_buf.read(&mut nonce).enq()?;
            result_hash_buf.read(&mut hash).enq()?;
            
            return Ok(Some((nonce[0], hash)));
        }

        start_nonce = start_nonce.wrapping_add(batch_size as u64);
    }

    Ok(None)
}

#[cfg(not(feature = "gpu"))]
pub async fn mine(
    _challenge: &[u8; 32],
    _difficulty: u128,
    _device_index: usize,
    _hash_counter: Arc<AtomicU64>,
    _running: Arc<AtomicBool>,
) -> Result<Option<(u64, [u8; 32])>> {
    Err(anyhow!("GPU support not compiled"))
}
