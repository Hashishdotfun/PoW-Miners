// =============================================================================
// CHAIN CLIENT - Interaction avec Solana
// =============================================================================

use anyhow::{Context, Result, anyhow};
use log::{info, debug};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer, read_keypair_file},
    transaction::Transaction,
    system_program,
};
use spl_token_2022;
use std::str::FromStr;

use crate::config::MinerConfig;

// =============================================================================
// STRUCTS
// =============================================================================

/// État du protocole PoW
#[derive(Debug, Clone)]
pub struct PowState {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub difficulty: u128,
    pub last_block_ts: i64,
    pub blocks_mined: u64,
    pub total_supply_mined: u64,
    pub challenge: [u8; 32],
    pub pending_reward_tokens: u64,
    pub fee_sol: u64,
    pub launch_ts: i64,
    pub is_initialized: bool,
    pub is_paused: bool,
}

/// Client pour interagir avec le protocole
pub struct ChainClient {
    rpc: RpcClient,
    keypair: Keypair,
    program_id: Pubkey,
    mint: Pubkey,
    pow_config_pda: Pubkey,
    miner_stats_pda: Pubkey,
    fee_vault_pda: Pubkey,
    miner_token_account: Pubkey,
}

impl ChainClient {
    /// Créer un nouveau client
    pub async fn new(config: &MinerConfig) -> Result<Self> {
        // Client RPC
        let rpc = RpcClient::new_with_commitment(
            &config.rpc_url,
            CommitmentConfig::confirmed(),
        );

        // Charger le keypair
        let keypair = read_keypair_file(&config.wallet_path)
            .map_err(|e| anyhow!("Failed to load wallet: {}", e))?;

        let program_id = Pubkey::from_str(&config.program_id)
            .context("Invalid program ID")?;
        
        let mint = Pubkey::from_str(&config.mint)
            .context("Invalid mint address")?;

        // Dériver les PDAs
        let (pow_config_pda, _) = Pubkey::find_program_address(
            &[b"pow_config"],
            &program_id,
        );

        let (miner_stats_pda, _) = Pubkey::find_program_address(
            &[b"miner_stats", keypair.pubkey().as_ref()],
            &program_id,
        );

        let (fee_vault_pda, _) = Pubkey::find_program_address(
            &[b"fee_vault"],
            &program_id,
        );

        // Token account du miner
        let miner_token_account = spl_associated_token_account::get_associated_token_address_with_program_id(
            &keypair.pubkey(),
            &mint,
            &spl_token_2022::id(),
        );

        Ok(Self {
            rpc,
            keypair,
            program_id,
            mint,
            pow_config_pda,
            miner_stats_pda,
            fee_vault_pda,
            miner_token_account,
        })
    }

    /// Récupérer le solde du miner
    pub async fn get_balance(&self) -> Result<u64> {
        let balance = self.rpc.get_balance(&self.keypair.pubkey())?;
        Ok(balance)
    }

    /// Récupérer l'état du protocole
    pub async fn get_pow_state(&self) -> Result<PowState> {
        let account = self.rpc.get_account(&self.pow_config_pda)
            .context("Failed to fetch PoW config account")?;

        parse_pow_config(&account.data)
    }

    /// Soumettre une preuve de travail
    pub async fn submit_proof(&self, nonce: u64) -> Result<String> {
        // Construire l'instruction
        // Discriminator pour "submit_proof" dans Anchor
        // En production, utiliser le client IDL généré
        let mut data = Vec::with_capacity(16);
        
        // Discriminator (à adapter selon votre programme)
        // C'est le hash SHA256 des 8 premiers bytes de "global:submit_proof"
        data.extend_from_slice(&[0x4e, 0x41, 0x4a, 0x8d, 0x2c, 0x1d, 0x3e, 0x5f]); // Placeholder
        
        // Nonce (u64, little-endian)
        data.extend_from_slice(&nonce.to_le_bytes());

        let instruction = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.keypair.pubkey(), true),      // miner (signer, writable)
                AccountMeta::new(self.pow_config_pda, false),        // pow_config
                AccountMeta::new(self.mint, false),                  // mint
                AccountMeta::new(self.miner_token_account, false),   // miner_token_account
                AccountMeta::new(self.miner_stats_pda, false),       // miner_stats
                AccountMeta::new(self.fee_vault_pda, false),         // fee_collector
                AccountMeta::new_readonly(spl_token_2022::id(), false), // token_program
                AccountMeta::new_readonly(system_program::id(), false), // system_program
            ],
            data,
        };

        // Créer et envoyer la transaction
        let recent_blockhash = self.rpc.get_latest_blockhash()?;
        
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.keypair.pubkey()),
            &[&self.keypair],
            recent_blockhash,
        );

        let signature = self.rpc.send_and_confirm_transaction(&transaction)?;
        
        Ok(signature.to_string())
    }

    /// Vérifier si le token account existe, sinon le créer
    pub async fn ensure_token_account(&self) -> Result<()> {
        let account = self.rpc.get_account(&self.miner_token_account);
        
        if account.is_err() {
            info!("Creating token account...");
            
            let instruction = spl_associated_token_account::instruction::create_associated_token_account(
                &self.keypair.pubkey(),
                &self.keypair.pubkey(),
                &self.mint,
                &spl_token_2022::id(),
            );

            let recent_blockhash = self.rpc.get_latest_blockhash()?;
            
            let transaction = Transaction::new_signed_with_payer(
                &[instruction],
                Some(&self.keypair.pubkey()),
                &[&self.keypair],
                recent_blockhash,
            );

            self.rpc.send_and_confirm_transaction(&transaction)?;
            info!("Token account created!");
        }

        Ok(())
    }

    /// Récupérer le solde de tokens
    pub async fn get_token_balance(&self) -> Result<u64> {
        let account = self.rpc.get_token_account_balance(&self.miner_token_account)?;
        let amount = account.amount.parse::<u64>().unwrap_or(0);
        Ok(amount)
    }
}

// =============================================================================
// PARSING
// =============================================================================

/// Parse les données du compte PowConfig
fn parse_pow_config(data: &[u8]) -> Result<PowState> {
    if data.len() < 200 {
        return Err(anyhow!("Invalid PowConfig data length"));
    }

    // Skip discriminator (8 bytes)
    let mut offset = 8;

    // authority (32 bytes)
    let authority = Pubkey::try_from(&data[offset..offset + 32])
        .map_err(|_| anyhow!("Invalid authority pubkey"))?;
    offset += 32;

    // mint (32 bytes)
    let mint = Pubkey::try_from(&data[offset..offset + 32])
        .map_err(|_| anyhow!("Invalid mint pubkey"))?;
    offset += 32;

    // difficulty (u128, 16 bytes)
    let difficulty = u128::from_le_bytes(data[offset..offset + 16].try_into()?);
    offset += 16;

    // last_block_ts (i64, 8 bytes)
    let last_block_ts = i64::from_le_bytes(data[offset..offset + 8].try_into()?);
    offset += 8;

    // blocks_mined (u64, 8 bytes)
    let blocks_mined = u64::from_le_bytes(data[offset..offset + 8].try_into()?);
    offset += 8;

    // total_supply_mined (u64, 8 bytes)
    let total_supply_mined = u64::from_le_bytes(data[offset..offset + 8].try_into()?);
    offset += 8;

    // current_challenge (32 bytes)
    let mut challenge = [0u8; 32];
    challenge.copy_from_slice(&data[offset..offset + 32]);
    offset += 32;

    // pending_reward_tokens (u64, 8 bytes)
    let pending_reward_tokens = u64::from_le_bytes(data[offset..offset + 8].try_into()?);
    offset += 8;

    // fee_sol_current (u64, 8 bytes)
    let fee_sol = u64::from_le_bytes(data[offset..offset + 8].try_into()?);
    offset += 8;

    // Skip les compteurs de fees (32 bytes: 4 x u64)
    offset += 32;

    // Skip les compteurs de burns (16 bytes: 2 x u64)
    offset += 16;

    // launch_ts (i64, 8 bytes)
    let launch_ts = i64::from_le_bytes(data[offset..offset + 8].try_into()?);
    offset += 8;

    // Skip last_fee_update_ts
    offset += 8;

    // is_initialized (bool, 1 byte)
    let is_initialized = data[offset] != 0;
    offset += 1;

    // is_paused (bool, 1 byte)
    let is_paused = data[offset] != 0;

    Ok(PowState {
        authority,
        mint,
        difficulty,
        last_block_ts,
        blocks_mined,
        total_supply_mined,
        challenge,
        pending_reward_tokens,
        fee_sol,
        launch_ts,
        is_initialized,
        is_paused,
    })
}
