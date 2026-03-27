//! Client Solana pour interagir avec le protocole PoW

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use anyhow::{Context, Result};
use log::info;
use std::str::FromStr;

// Token-2022 program ID
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const POW_CONFIG_SEED: &[u8] = b"pow_config";
const FEE_VAULT_SEED: &[u8] = b"fee_vault";
const MINER_STATS_SEED: &[u8] = b"miner_stats";
const MINT_AUTHORITY_SEED: &[u8] = b"pow_mint_auth";
const DEVICE_ATTEST_SEED: &[u8] = b"device_attest";
const CYCLE_GATE_SEED: &[u8] = b"cycle_gate";

const POOL_NORMAL: u8 = 0;
const POOL_SEEKER: u8 = 1;

/// Protocol state read from on-chain
#[derive(Debug, Clone)]
pub struct ProtocolState {
    pub difficulty: u128,
    pub blocks_mined: u64,
    pub current_challenge: [u8; 32],
    pub fee_sol_current: u64,
    pub is_paused: bool,
}

/// Client for interacting with the PoW protocol
pub struct SolanaClient {
    rpc: RpcClient,
    miner_keypair: Keypair,
    program_id: Pubkey,
    pool_id: u8,
    pow_config: Pubkey,
    other_pool: Pubkey,
    mint_authority: Pubkey,
    mint: Pubkey,
    fee_vault: Pubkey,
    miner_stats: Pubkey,
    miner_token_account: Pubkey,
    attestation: Pubkey,
    cycle_gate: Pubkey,
}

// Discriminator for submit_proof instruction
const SUBMIT_PROOF_DISCRIMINATOR: [u8; 8] = [54, 241, 46, 84, 4, 212, 46, 94];

impl SolanaClient {
    /// Create a new client for a specific pool
    pub fn new(
        rpc_url: &str,
        keypair_path: &str,
        program_id_str: &str,
        mint_str: &str,
        pool_id: u8,
    ) -> Result<Self> {
        let miner_keypair = read_keypair_file(keypair_path)
            .map_err(|e| anyhow::anyhow!("Failed to read keypair from {}: {}", keypair_path, e))?;

        let program_id = Pubkey::from_str(program_id_str)
            .with_context(|| format!("Invalid program ID: {}", program_id_str))?;
        let mint = Pubkey::from_str(mint_str)
            .with_context(|| format!("Invalid mint: {}", mint_str))?;

        let rpc = RpcClient::new_with_commitment(
            rpc_url.to_string(),
            CommitmentConfig::confirmed(),
        );

        // Derive PDAs with pool_id
        let other_pool_id = if pool_id == POOL_NORMAL { POOL_SEEKER } else { POOL_NORMAL };

        let (pow_config, _) = Pubkey::find_program_address(
            &[POW_CONFIG_SEED, &[pool_id]], &program_id,
        );
        let (other_pool, _) = Pubkey::find_program_address(
            &[POW_CONFIG_SEED, &[other_pool_id]], &program_id,
        );
        let (mint_authority, _) = Pubkey::find_program_address(
            &[MINT_AUTHORITY_SEED], &program_id,
        );
        let (fee_vault, _) = Pubkey::find_program_address(
            &[FEE_VAULT_SEED], &program_id,
        );
        let (miner_stats, _) = Pubkey::find_program_address(
            &[MINER_STATS_SEED, &[pool_id], miner_keypair.pubkey().as_ref()], &program_id,
        );
        let (attestation, _) = Pubkey::find_program_address(
            &[DEVICE_ATTEST_SEED, miner_keypair.pubkey().as_ref()], &program_id,
        );
        let (cycle_gate, _) = Pubkey::find_program_address(
            &[CYCLE_GATE_SEED], &program_id,
        );

        // Derive associated token address for Token-2022
        let token_program = Pubkey::from_str(TOKEN_2022_PROGRAM_ID)?;
        let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
        let (miner_token_account, _) = Pubkey::find_program_address(
            &[
                miner_keypair.pubkey().as_ref(),
                token_program.as_ref(),
                mint.as_ref(),
            ],
            &ata_program,
        );

        info!("Miner: {}", miner_keypair.pubkey());
        info!("  Pool: {} ({})", pool_id, if pool_id == POOL_NORMAL { "normal" } else { "seeker" });
        info!("  PoW Config: {}", pow_config);
        info!("  Token Account: {}", miner_token_account);

        Ok(Self {
            rpc,
            miner_keypair,
            program_id,
            pool_id,
            pow_config,
            other_pool,
            mint_authority,
            mint,
            fee_vault,
            miner_stats,
            miner_token_account,
            attestation,
            cycle_gate,
        })
    }

    /// Fetch current protocol state from on-chain
    pub fn fetch_protocol_state(&self) -> Result<ProtocolState> {
        let account = self.rpc.get_account(&self.pow_config)?;
        let data = account.data;

        // PowConfig layout offsets:
        // 8  discriminator
        // 32 authority       (offset 8)
        // 32 mint            (offset 40)
        // 16 difficulty      (offset 72)
        // 8  last_block_ts   (offset 88)
        // 8  blocks_mined    (offset 96)
        // 8  total_supply_mined (offset 104)
        // 32 current_challenge (offset 112)
        // 8  pending_reward_tokens (offset 144)
        // 8  fee_sol_current (offset 152)
        // 8  total_fees_collected (offset 160)
        // 8  total_team_fees (offset 168)
        // 8  total_buyback_sol (offset 176)
        // 8  total_lp_sol    (offset 184)
        // 8  total_burned_from_buyback (offset 192)
        // 8  total_burned_from_transfer_tax (offset 200)
        // 8  launch_ts       (offset 208)
        // 8  last_fee_update_ts (offset 216)
        // 1  is_initialized  (offset 224)
        // 1  is_paused       (offset 225)

        if data.len() < 226 {
            anyhow::bail!("Invalid account data length: {} (expected >= 226)", data.len());
        }

        let difficulty = u128::from_le_bytes(data[72..88].try_into()?);
        let blocks_mined = u64::from_le_bytes(data[96..104].try_into()?);
        let current_challenge: [u8; 32] = data[112..144].try_into()?;
        let fee_sol_current = u64::from_le_bytes(data[152..160].try_into()?);
        let is_paused = data[225] != 0;

        Ok(ProtocolState {
            difficulty,
            blocks_mined,
            current_challenge,
            fee_sol_current,
            is_paused,
        })
    }

    /// Submit a proof of work
    pub fn submit_proof(&self, nonce: u128) -> Result<String> {
        let token_program = Pubkey::from_str(TOKEN_2022_PROGRAM_ID)?;

        // Instruction data: discriminator (8) + nonce (u128 = 16 bytes)
        let mut instruction_data = Vec::with_capacity(24);
        instruction_data.extend_from_slice(&SUBMIT_PROOF_DISCRIMINATOR);
        instruction_data.extend_from_slice(&nonce.to_le_bytes());

        // Account list matching SubmitProof struct order exactly
        let accounts = vec![
            AccountMeta::new(self.miner_keypair.pubkey(), true),    // miner
            AccountMeta::new(self.pow_config, false),                // pow_config
            AccountMeta::new_readonly(self.other_pool, false),       // other_pool
            AccountMeta::new_readonly(self.mint_authority, false),   // mint_authority
            AccountMeta::new(self.mint, false),                      // mint
            AccountMeta::new(self.miner_token_account, false),       // miner_token_account
            AccountMeta::new(self.miner_stats, false),               // miner_stats
            AccountMeta::new(self.fee_vault, false),                 // fee_collector
            // attestation (optional): None for normal pool
            if self.pool_id == POOL_SEEKER {
                AccountMeta::new(self.attestation, false)
            } else {
                AccountMeta::new_readonly(self.program_id, false)
            },
            AccountMeta::new(self.cycle_gate, false),                // cycle_gate
            AccountMeta::new_readonly(token_program, false),         // token_program
            AccountMeta::new_readonly(system_program::ID, false),    // system_program
        ];

        let submit_ix = Instruction {
            program_id: self.program_id,
            accounts,
            data: instruction_data,
        };

        let compute_budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(400_000);

        let recent_blockhash = self.rpc.get_latest_blockhash()?;
        let tx = Transaction::new_signed_with_payer(
            &[compute_budget_ix, submit_ix],
            Some(&self.miner_keypair.pubkey()),
            &[&self.miner_keypair],
            recent_blockhash,
        );

        let sig = self.rpc.send_and_confirm_transaction(&tx)?;
        Ok(sig.to_string())
    }

    /// Get the miner's pubkey
    pub fn miner_pubkey(&self) -> Pubkey {
        self.miner_keypair.pubkey()
    }

    /// Get the miner's SOL balance
    pub fn get_balance(&self) -> Result<u64> {
        Ok(self.rpc.get_balance(&self.miner_keypair.pubkey())?)
    }
}
