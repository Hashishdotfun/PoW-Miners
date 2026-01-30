/**
 * CUDA Kernel pour Mining SHA256
 * 
 * Ce kernel calcule SHA256(challenge || nonce) pour trouver un hash < target
 */

#include <stdint.h>

// ============================================================================
// SHA256 Constants
// ============================================================================

__constant__ uint32_t K[64] = {
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

// ============================================================================
// SHA256 Helper Functions
// ============================================================================

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define SHR(x, n) ((x) >> (n))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define EP1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ SHR(x, 3))
#define SIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ SHR(x, 10))

// ============================================================================
// SHA256 Transform
// ============================================================================

__device__ void sha256_transform(uint32_t state[8], const uint8_t data[64]) {
    uint32_t a, b, c, d, e, f, g, h, t1, t2, m[64];
    int i, j;

    // Prepare message schedule
    for (i = 0, j = 0; i < 16; ++i, j += 4) {
        m[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | (data[j + 3]);
    }
    for (; i < 64; ++i) {
        m[i] = SIG1(m[i - 2]) + m[i - 7] + SIG0(m[i - 15]) + m[i - 16];
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

    // Compression function
    for (i = 0; i < 64; ++i) {
        t1 = h + EP1(e) + CH(e, f, g) + K[i] + m[i];
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

    // Add compressed chunk to state
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

// ============================================================================
// SHA256 Main Function
// ============================================================================

__device__ void sha256_hash(const uint8_t* data, size_t len, uint8_t hash[32]) {
    uint32_t state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };

    uint8_t block[64];
    size_t i;

    // Process full blocks
    for (i = 0; i + 64 <= len; i += 64) {
        sha256_transform(state, data + i);
    }

    // Padding
    size_t remaining = len - i;
    for (size_t j = 0; j < remaining; j++) {
        block[j] = data[i + j];
    }
    block[remaining] = 0x80;
    
    if (remaining >= 56) {
        for (size_t j = remaining + 1; j < 64; j++) {
            block[j] = 0;
        }
        sha256_transform(state, block);
        for (size_t j = 0; j < 56; j++) {
            block[j] = 0;
        }
    } else {
        for (size_t j = remaining + 1; j < 56; j++) {
            block[j] = 0;
        }
    }

    // Add length in bits
    uint64_t bit_len = len * 8;
    block[56] = (bit_len >> 56) & 0xff;
    block[57] = (bit_len >> 48) & 0xff;
    block[58] = (bit_len >> 40) & 0xff;
    block[59] = (bit_len >> 32) & 0xff;
    block[60] = (bit_len >> 24) & 0xff;
    block[61] = (bit_len >> 16) & 0xff;
    block[62] = (bit_len >> 8) & 0xff;
    block[63] = bit_len & 0xff;

    sha256_transform(state, block);

    // Produce final hash
    for (i = 0; i < 8; i++) {
        hash[i * 4] = (state[i] >> 24) & 0xff;
        hash[i * 4 + 1] = (state[i] >> 16) & 0xff;
        hash[i * 4 + 2] = (state[i] >> 8) & 0xff;
        hash[i * 4 + 3] = state[i] & 0xff;
    }
}

// ============================================================================
// Mining Kernel
// ============================================================================

extern "C" __global__ void mine_block(
    const uint8_t* challenge,      // 32 bytes challenge
    const uint8_t* miner_pubkey,   // 32 bytes miner public key
    uint64_t block_number,         // Block number
    uint64_t start_nonce,          // Starting nonce
    uint64_t nonce_count,          // Number of nonces to test
    const uint8_t* target,         // 32 bytes target (big-endian)
    uint64_t* result_nonce,        // Output: found nonce
    int* found                     // Output: 1 if found, 0 otherwise
) {
    // Calculate global thread ID
    uint64_t idx = blockIdx.x * blockDim.x + threadIdx.x;

    if (idx >= nonce_count) return;

    uint64_t nonce = start_nonce + idx;

    // Prepare data: challenge (32) + miner_pubkey (32) + nonce (16 as u128) + block_number (8) = 88 bytes
    uint8_t data[88];

    // Copy challenge (32 bytes)
    for (int i = 0; i < 32; i++) {
        data[i] = challenge[i];
    }

    // Copy miner_pubkey (32 bytes)
    for (int i = 0; i < 32; i++) {
        data[32 + i] = miner_pubkey[i];
    }

    // Add nonce as u128 (little-endian, low 64 bits first, then high 64 bits = 0)
    data[64] = nonce & 0xff;
    data[65] = (nonce >> 8) & 0xff;
    data[66] = (nonce >> 16) & 0xff;
    data[67] = (nonce >> 24) & 0xff;
    data[68] = (nonce >> 32) & 0xff;
    data[69] = (nonce >> 40) & 0xff;
    data[70] = (nonce >> 48) & 0xff;
    data[71] = (nonce >> 56) & 0xff;
    // High 64 bits of u128 are zero (nonce fits in u64)
    data[72] = 0;
    data[73] = 0;
    data[74] = 0;
    data[75] = 0;
    data[76] = 0;
    data[77] = 0;
    data[78] = 0;
    data[79] = 0;

    // Add block_number in little-endian
    data[80] = block_number & 0xff;
    data[81] = (block_number >> 8) & 0xff;
    data[82] = (block_number >> 16) & 0xff;
    data[83] = (block_number >> 24) & 0xff;
    data[84] = (block_number >> 32) & 0xff;
    data[85] = (block_number >> 40) & 0xff;
    data[86] = (block_number >> 48) & 0xff;
    data[87] = (block_number >> 56) & 0xff;

    // Compute hash
    uint8_t hash[32];
    sha256_hash(data, 88, hash);

    // Compare first 16 bytes as little-endian u128 (same as Rust side)
    // Convert hash[0..16] to u128 (little-endian)
    unsigned long long hash_low = 0;
    unsigned long long hash_high = 0;
    for (int i = 0; i < 8; i++) {
        hash_low |= ((unsigned long long)hash[i]) << (i * 8);
        hash_high |= ((unsigned long long)hash[i + 8]) << (i * 8);
    }

    // Convert target[0..16] to u128 (little-endian)
    unsigned long long target_low = 0;
    unsigned long long target_high = 0;
    for (int i = 0; i < 8; i++) {
        target_low |= ((unsigned long long)target[i]) << (i * 8);
        target_high |= ((unsigned long long)target[i + 8]) << (i * 8);
    }

    // Compare as u128: high bits first, then low bits
    bool is_valid = false;
    if (hash_high < target_high) {
        is_valid = true;
    } else if (hash_high == target_high && hash_low < target_low) {
        is_valid = true;
    }
    
    // If valid, atomically set the result
    if (is_valid) {
        atomicExch(found, 1);
        atomicExch((unsigned long long*)result_nonce, nonce);
    }
}

// ============================================================================
// Batch Mining Kernel (optimized for multiple attempts)
// ============================================================================

extern "C" __global__ void mine_block_batch(
    const uint8_t* challenges,     // N × 32 bytes challenges
    uint64_t start_nonce,
    uint64_t nonce_count,
    const uint8_t* target,
    uint64_t* result_nonces,       // N outputs
    int* found_flags,              // N outputs
    int num_challenges
) {
    uint64_t idx = blockIdx.x * blockDim.x + threadIdx.x;
    
    if (idx >= nonce_count) return;
    
    uint64_t nonce = start_nonce + idx;
    
    // Process each challenge
    for (int ch = 0; ch < num_challenges; ch++) {
        if (found_flags[ch]) continue;  // Already found
        
        const uint8_t* challenge = challenges + (ch * 32);
        
        uint8_t data[40];
        for (int i = 0; i < 32; i++) {
            data[i] = challenge[i];
        }
        
        // Add nonce
        data[32] = nonce & 0xff;
        data[33] = (nonce >> 8) & 0xff;
        data[34] = (nonce >> 16) & 0xff;
        data[35] = (nonce >> 24) & 0xff;
        data[36] = (nonce >> 32) & 0xff;
        data[37] = (nonce >> 40) & 0xff;
        data[38] = (nonce >> 48) & 0xff;
        data[39] = (nonce >> 56) & 0xff;
        
        uint8_t hash[32];
        sha256_hash(data, 40, hash);
        
        bool is_valid = true;
        for (int i = 0; i < 32; i++) {
            if (hash[i] < target[i]) break;
            else if (hash[i] > target[i]) {
                is_valid = false;
                break;
            }
        }
        
        if (is_valid) {
            atomicExch(&found_flags[ch], 1);
            atomicExch((unsigned long long*)&result_nonces[ch], nonce);
        }
    }
}
