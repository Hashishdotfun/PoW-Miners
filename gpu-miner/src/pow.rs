//! Logique Proof of Work (CPU)

use sha2::{Sha256, Digest};

/// Calcule le hash PoW: SHA256(challenge || miner_pubkey || nonce || block_number)
///
/// L'inclusion de miner_pubkey garantit que chaque mineur a son propre espace de recherche
/// et empêche le vol de travail dans les pools.
pub fn compute_hash(challenge: &[u8; 32], miner_pubkey: &[u8; 32], nonce: u128, block_number: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(challenge);              // 32 bytes - Challenge actuel
    hasher.update(miner_pubkey);           // 32 bytes - Adresse du mineur
    hasher.update(&nonce.to_le_bytes());   // 16 bytes - Nonce du miner (u128)
    hasher.update(&block_number.to_le_bytes()); // 8 bytes  - Numéro de bloc
    hasher.finalize().into()
}

/// Vérifie si un nonce est valide
pub fn verify_nonce(challenge: &[u8; 32], miner_pubkey: &[u8; 32], nonce: u128, block_number: u64, target: u128) -> bool {
    let hash = compute_hash(challenge, miner_pubkey, nonce, block_number);
    let hash_value = u128::from_le_bytes(hash[..16].try_into().unwrap());
    hash_value < target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_hash() {
        let challenge = [0u8; 32];
        let miner_pubkey = [1u8; 32];
        let nonce = 12345;
        let block_number = 100;
        let hash = compute_hash(&challenge, &miner_pubkey, nonce, block_number);

        // Le hash devrait être déterministe
        let hash2 = compute_hash(&challenge, &miner_pubkey, nonce, block_number);
        assert_eq!(hash, hash2);

        // Le hash devrait changer si block_number change
        let hash3 = compute_hash(&challenge, &miner_pubkey, nonce, block_number + 1);
        assert_ne!(hash, hash3);

        // Le hash devrait changer si miner_pubkey change
        let other_miner = [2u8; 32];
        let hash4 = compute_hash(&challenge, &other_miner, nonce, block_number);
        assert_ne!(hash, hash4);
    }

    #[test]
    fn test_verify_nonce() {
        let challenge = [0u8; 32];
        let miner_pubkey = [1u8; 32];
        let block_number = 100;
        let target = u128::MAX / 1000; // Facile

        // Trouver un nonce valide
        for nonce in 0..10_000 {
            if verify_nonce(&challenge, &miner_pubkey, nonce, block_number, target) {
                println!("✓ Found valid nonce: {} for block {}", nonce, block_number);
                return;
            }
        }

        panic!("No valid nonce found in 10k attempts");
    }
}
