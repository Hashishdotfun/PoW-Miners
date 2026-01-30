//! Client Solana pour interagir avec le protocole PoW

use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig,
        pubkey::Pubkey,
        signature::{read_keypair_file, Keypair, Signer},
        system_program,
        instruction::{AccountMeta, Instruction},
    },
    Client,
};
use anyhow::{Context, Result};
use log::info;
use std::rc::Rc;
use std::str::FromStr;

// Token-2022 program ID
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const POW_CONFIG_SEED: &[u8] = b"pow_config";
const FEE_VAULT_SEED: &[u8] = b"fee_vault";
const MINER_STATS_SEED: &[u8] = b"miner_stats";

/// Configuration du protocole lue depuis la blockchain
#[derive(Debug)]
pub struct ProtocolState {
    pub difficulty: u128,
    pub blocks_mined: u64,
    pub current_challenge: [u8; 32],
    pub fee_sol_current: u64,
}

/// Client pour interagir avec le protocole PoW
pub struct SolanaClient {
    client: Client<Rc<Keypair>>,
    miner_keypair: Rc<Keypair>,
    program_id: Pubkey,
    mint: Pubkey,
    pow_config: Pubkey,
    fee_vault: Pubkey,
    miner_stats: Pubkey,
    miner_token_account: Pubkey,
}

// Discriminator pour l'instruction submit_proof (calculé depuis "global:submit_proof")
const SUBMIT_PROOF_DISCRIMINATOR: [u8; 8] = [54, 241, 46, 84, 4, 212, 46, 94];

impl SolanaClient {
    /// Créer un nouveau client
    pub fn new(
        rpc_url: &str,
        keypair_path: &str,
        program_id_str: &str,
        mint_str: &str,
    ) -> Result<Self> {
        // Load keypair
        let miner_keypair = read_keypair_file(keypair_path)
            .with_context(|| format!("Failed to read keypair from {}", keypair_path))?;
        let miner_keypair = Rc::new(miner_keypair);

        // Parse program ID and mint
        let program_id = Pubkey::from_str(program_id_str)
            .with_context(|| format!("Invalid program ID: {}", program_id_str))?;
        let mint = Pubkey::from_str(mint_str)
            .with_context(|| format!("Invalid mint: {}", mint_str))?;

        // Create Anchor client
        let client = Client::new_with_options(
            anchor_client::Cluster::Custom(rpc_url.to_string(), "".to_string()),
            miner_keypair.clone(),
            CommitmentConfig::confirmed(),
        );

        // Derive PDAs
        let (pow_config, _) = Pubkey::find_program_address(&[POW_CONFIG_SEED], &program_id);
        let (fee_vault, _) = Pubkey::find_program_address(&[FEE_VAULT_SEED], &program_id);
        let (miner_stats, _) = Pubkey::find_program_address(
            &[MINER_STATS_SEED, miner_keypair.pubkey().as_ref()],
            &program_id,
        );

        // Get token account
        let token_program = Pubkey::from_str(TOKEN_2022_PROGRAM_ID)?;

        // Derive associated token address manually
        let miner_token_account = Pubkey::find_program_address(
            &[
                miner_keypair.pubkey().as_ref(),
                token_program.as_ref(),
                mint.as_ref(),
            ],
            &Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?, // ATA program
        ).0;

        info!("📍 Miner: {}", miner_keypair.pubkey());
        info!("   PoW Config: {}", pow_config);
        info!("   Token Account: {}", miner_token_account);

        Ok(Self {
            client,
            miner_keypair,
            program_id,
            mint,
            pow_config,
            fee_vault,
            miner_stats,
            miner_token_account,
        })
    }

    /// Récupérer l'état actuel du protocole
    pub fn fetch_protocol_state(&self) -> Result<ProtocolState> {
        let account = self.client.program(self.program_id)?.rpc().get_account(&self.pow_config)?;
        let data = account.data;

        // Parse account data
        // Layout: discriminator(8) + authority(32) + mint(32) + difficulty(16) +
        //         last_block_ts(8) + blocks_mined(8) + total_supply_mined(8) + current_challenge(32)

        if data.len() < 144 {
            anyhow::bail!("Invalid account data length: {}", data.len());
        }

        // Read difficulty as u128 (16 bytes) at offset 72
        let difficulty_bytes: [u8; 16] = data[72..88].try_into()?;
        let difficulty = u128::from_le_bytes(difficulty_bytes);

        // blocks_mined at offset 96
        let blocks_mined_bytes: [u8; 8] = data[96..104].try_into()?;
        let blocks_mined = u64::from_le_bytes(blocks_mined_bytes);

        // Challenge at offset 112
        let current_challenge: [u8; 32] = data[112..144].try_into()?;

        // Fee at offset (need to calculate based on full struct layout)
        // For now, use a default or read from correct offset
        let fee_sol_current = 5_000_000; // 0.005 SOL default

        Ok(ProtocolState {
            difficulty,
            blocks_mined,
            current_challenge,
            fee_sol_current,
        })
    }

    /// Soumettre une preuve
    pub fn submit_proof(&self, nonce: u64) -> Result<String> {
        let token_program = Pubkey::from_str(TOKEN_2022_PROGRAM_ID)?;

        // Construire les données de l'instruction: discriminator + nonce (u64)
        let mut instruction_data = Vec::with_capacity(16);
        instruction_data.extend_from_slice(&SUBMIT_PROOF_DISCRIMINATOR);
        instruction_data.extend_from_slice(&nonce.to_le_bytes());

        // Construire les comptes de l'instruction
        let accounts = vec![
            AccountMeta::new(self.miner_keypair.pubkey(), true), // miner (signer)
            AccountMeta::new(self.pow_config, false),            // pow_config
            AccountMeta::new(self.mint, false),                  // mint
            AccountMeta::new(self.miner_token_account, false),   // miner_token_account
            AccountMeta::new(self.miner_stats, false),           // miner_stats
            AccountMeta::new(self.fee_vault, false),             // fee_collector
            AccountMeta::new_readonly(token_program, false),     // token_program
            AccountMeta::new_readonly(system_program::ID, false), // system_program
        ];

        let instruction = Instruction {
            program_id: self.program_id,
            accounts,
            data: instruction_data,
        };

        // Envoyer la transaction
        let tx = self
            .client
            .program(self.program_id)?
            .request()
            .instruction(instruction)
            .send()?;

        Ok(tx.to_string())
    }

    /// Obtenir le pubkey du mineur
    pub fn miner_pubkey(&self) -> &Pubkey {
        &self.miner_keypair.pubkey()
    }
}
