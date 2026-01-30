// =============================================================================
// CPU MINING - Multi-threaded with Rayon
// =============================================================================
// Fallback quand GPU n'est pas disponible
// Optimisé avec SIMD hints et cache-friendly access

use anyhow::Result;
use sha2::{Sha256, Digest};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

#[cfg(feature = "cpu")]
use rayon::prelude::*;

/// Batch size pour chaque thread
const BATCH_SIZE: u64 = 10_000;

/// Mine sur CPU multi-thread
#[cfg(feature = "cpu")]
pub async fn mine(
    challenge: &[u8; 32],
    block_number: u64,
    difficulty: u128,
    threads: usize,
    hash_counter: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
) -> Result<Option<(u64, [u8; 32])>> {
    // Configurer le pool de threads
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global()
        .ok(); // Ignore si déjà configuré

    // Calculer le target
    let target = u128::MAX / difficulty;

    // Préparer le message de base (challenge)
    let challenge = *challenge;

    // Nonce de départ aléatoire pour éviter les collisions entre mineurs
    let start_nonce: u64 = rand::random();

    // Boucle de mining
    let mut batch_start = start_nonce;

    while running.load(Ordering::Relaxed) {
        // Diviser le travail en batches pour chaque thread
        let batch_count = threads as u64;
        let total_batch = BATCH_SIZE * batch_count;

        // Créer les ranges pour chaque batch
        let batches: Vec<(u64, u64)> = (0..batch_count)
            .map(|i| {
                let start = batch_start.wrapping_add(i * BATCH_SIZE);
                let end = start.wrapping_add(BATCH_SIZE);
                (start, end)
            })
            .collect();

        // Exécuter en parallèle
        let result: Option<(u64, [u8; 32])> = batches
            .par_iter()
            .find_map_any(|(start, end)| {
                mine_batch(&challenge, block_number, target, *start, *end, &running)
            });

        // Mettre à jour le compteur
        hash_counter.fetch_add(total_batch, Ordering::Relaxed);

        // Vérifier si on a trouvé
        if let Some(result) = result {
            return Ok(Some(result));
        }

        // Passer au batch suivant
        batch_start = batch_start.wrapping_add(total_batch);
    }

    Ok(None)
}

#[cfg(not(feature = "cpu"))]
pub async fn mine(
    _challenge: &[u8; 32],
    _block_number: u64,
    _difficulty: u128,
    _threads: usize,
    _hash_counter: Arc<AtomicU64>,
    _running: Arc<AtomicBool>,
) -> Result<Option<(u64, [u8; 32])>> {
    anyhow::bail!("CPU support not compiled. Rebuild with --features cpu")
}

/// Mine un batch de nonces
#[cfg(feature = "cpu")]
fn mine_batch(
    challenge: &[u8; 32],
    block_number: u64,
    target: u128,
    start: u64,
    end: u64,
    running: &Arc<AtomicBool>,
) -> Option<(u64, [u8; 32])> {
    // Préparer le buffer du message: challenge (32) + nonce (8) + block_number (8) = 48 bytes
    let mut message = [0u8; 48];
    message[..32].copy_from_slice(challenge);
    message[40..48].copy_from_slice(&block_number.to_le_bytes());

    for nonce in start..end {
        // Vérifier périodiquement si on doit s'arrêter
        if nonce % 1000 == 0 && !running.load(Ordering::Relaxed) {
            return None;
        }

        // Écrire le nonce (little-endian)
        message[32..40].copy_from_slice(&nonce.to_le_bytes());

        // Calculer le hash
        let hash = Sha256::digest(&message);

        // Vérifier si le hash est valide
        if is_valid_hash(&hash, target) {
            let mut hash_array = [0u8; 32];
            hash_array.copy_from_slice(&hash);
            return Some((nonce, hash_array));
        }
    }

    None
}

/// Vérifie si un hash est inférieur au target
#[inline(always)]
fn is_valid_hash(hash: &[u8], target: u128) -> bool {
    // Convertir les premiers 16 bytes en u128 (little-endian)
    let hash_value = u128::from_le_bytes(hash[..16].try_into().unwrap());
    hash_value < target
}

// =============================================================================
// OPTIMISATIONS ALTERNATIVES
// =============================================================================

/// Version avec unrolling manuel pour potentiellement plus de performance
#[cfg(feature = "cpu")]
#[allow(dead_code)]
fn mine_batch_unrolled(
    challenge: &[u8; 32],
    target: u128,
    start: u64,
    count: u64,
    running: &Arc<AtomicBool>,
) -> Option<(u64, [u8; 32])> {
    let mut message1 = [0u8; 40];
    let mut message2 = [0u8; 40];
    let mut message3 = [0u8; 40];
    let mut message4 = [0u8; 40];
    
    message1[..32].copy_from_slice(challenge);
    message2[..32].copy_from_slice(challenge);
    message3[..32].copy_from_slice(challenge);
    message4[..32].copy_from_slice(challenge);

    let end = start + count;
    let mut nonce = start;

    while nonce + 4 <= end {
        if nonce % 4000 == 0 && !running.load(Ordering::Relaxed) {
            return None;
        }

        // Écrire 4 nonces
        message1[32..40].copy_from_slice(&nonce.to_le_bytes());
        message2[32..40].copy_from_slice(&(nonce + 1).to_le_bytes());
        message3[32..40].copy_from_slice(&(nonce + 2).to_le_bytes());
        message4[32..40].copy_from_slice(&(nonce + 3).to_le_bytes());

        // Calculer 4 hashes
        let hash1 = Sha256::digest(&message1);
        let hash2 = Sha256::digest(&message2);
        let hash3 = Sha256::digest(&message3);
        let hash4 = Sha256::digest(&message4);

        // Vérifier
        if is_valid_hash(&hash1, target) {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hash1);
            return Some((nonce, h));
        }
        if is_valid_hash(&hash2, target) {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hash2);
            return Some((nonce + 1, h));
        }
        if is_valid_hash(&hash3, target) {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hash3);
            return Some((nonce + 2, h));
        }
        if is_valid_hash(&hash4, target) {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hash4);
            return Some((nonce + 3, h));
        }

        nonce += 4;
    }

    // Traiter les nonces restants
    while nonce < end {
        message1[32..40].copy_from_slice(&nonce.to_le_bytes());
        let hash = Sha256::digest(&message1);
        
        if is_valid_hash(&hash, target) {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hash);
            return Some((nonce, h));
        }
        
        nonce += 1;
    }

    None
}

// =============================================================================
// BENCHMARK UTILS
// =============================================================================

/// Benchmark le CPU pour estimer le hashrate
#[cfg(feature = "cpu")]
pub fn benchmark_cpu(duration_secs: u64) -> f64 {
    use std::time::{Duration, Instant};

    let challenge: [u8; 32] = rand::random();
    let block_number = 0; // Numéro de bloc fictif pour le benchmark
    let target = u128::MAX; // Target impossible = on mine juste pour mesurer
    let running = Arc::new(AtomicBool::new(true));

    let threads = num_cpus::get();
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global()
        .ok();

    let hash_counter = Arc::new(AtomicU64::new(0));
    let counter = hash_counter.clone();
    let r = running.clone();

    let handle = std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let _ = mine(&challenge, block_number, 1, threads, counter, r).await;
        });
    });

    std::thread::sleep(Duration::from_secs(duration_secs));
    running.store(false, Ordering::SeqCst);
    let _ = handle.join();

    let hashes = hash_counter.load(Ordering::Relaxed);
    hashes as f64 / duration_secs as f64
}
