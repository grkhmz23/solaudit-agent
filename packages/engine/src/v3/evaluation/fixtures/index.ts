/**
 * Synthetic Fixtures — Minimal Anchor programs per vulnerability class.
 *
 * Each fixture has:
 *   - vulnerable/lib.rs   — exploitable code
 *   - fixed/lib.rs        — patched code
 *   - expected.json       — expected findings
 *
 * These are used for unit-testing individual detectors
 * and for rapid regression checks without cloning external repos.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { VulnClass, CandidateSeverity } from "../../../v2/types";

// ─── Types ───────────────────────────────────────────────────

export interface SyntheticFixture {
  id: string;
  vulnClass: VulnClass;
  name: string;
  description: string;
  /** Vulnerable program source (lib.rs). */
  vulnerableSource: string;
  /** Fixed program source (lib.rs). */
  fixedSource: string;
  /** Expected finding in vulnerable version. */
  expected: {
    vulnClass: VulnClass;
    severity: CandidateSeverity;
    instruction: string;
    accountName?: string;
  };
}

// ─── Fixtures ────────────────────────────────────────────────

export const SYNTHETIC_FIXTURES: SyntheticFixture[] = [
  {
    id: "fix-missing-signer",
    vulnClass: "missing_signer",
    name: "Missing Signer on Withdraw",
    description: "Token withdraw without signer check on authority",
    vulnerableSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_missing_signer {
    use super::*;

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    /// CHECK: No signer check — VULNERABLE
    pub authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod fixed_missing_signer {
    use super::*;

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    expected: {
      vulnClass: "missing_signer",
      severity: "CRITICAL",
      instruction: "withdraw",
      accountName: "authority",
    },
  },

  {
    id: "fix-arbitrary-cpi",
    vulnClass: "arbitrary_cpi",
    name: "Arbitrary CPI Target",
    description: "CPI to unvalidated program account",
    vulnerableSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_arbitrary_cpi {
    use super::*;

    pub fn execute(ctx: Context<Execute>, data: Vec<u8>) -> Result<()> {
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ctx.accounts.target_program.key(),
            accounts: vec![],
            data,
        };
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[ctx.accounts.target_program.to_account_info()],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: No validation — VULNERABLE: attacker can pass any program
    pub target_program: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod fixed_arbitrary_cpi {
    use super::*;

    pub fn execute(ctx: Context<Execute>, data: Vec<u8>) -> Result<()> {
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![],
            data,
        };
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[ctx.accounts.token_program.to_account_info()],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Execute<'info> {
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub payer: Signer<'info>,
}
`.trim(),
    expected: {
      vulnClass: "arbitrary_cpi",
      severity: "CRITICAL",
      instruction: "execute",
      accountName: "target_program",
    },
  },

  {
    id: "fix-pda-derivation",
    vulnClass: "pda_derivation",
    name: "Non-canonical PDA Bump",
    description: "PDA created with create_program_address (unchecked bump)",
    vulnerableSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_pda {
    use super::*;

    pub fn verify_vault(ctx: Context<VerifyVault>, bump: u8) -> Result<()> {
        let expected = Pubkey::create_program_address(
            &[b"vault", ctx.accounts.owner.key.as_ref(), &[bump]],
            ctx.program_id,
        ).map_err(|_| error!(ErrorCode::InvalidPDA))?;
        require_keys_eq!(ctx.accounts.vault.key(), expected);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct VerifyVault<'info> {
    /// CHECK: manually verified — but bump is user-provided!
    pub vault: AccountInfo<'info>,
    pub owner: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid PDA")]
    InvalidPDA,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod fixed_pda {
    use super::*;

    pub fn verify_vault(_ctx: Context<VerifyVault>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct VerifyVault<'info> {
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA verified via seeds constraint with canonical bump
    pub vault: AccountInfo<'info>,
    pub owner: Signer<'info>,
}
`.trim(),
    expected: {
      vulnClass: "pda_derivation",
      severity: "HIGH",
      instruction: "verify_vault",
    },
  },

  {
    id: "fix-remaining-accounts",
    vulnClass: "remaining_accounts",
    name: "Unvalidated remaining_accounts",
    description: "remaining_accounts used as token accounts without validation",
    vulnerableSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_remaining {
    use super::*;

    pub fn distribute(ctx: Context<Distribute>, amount: u64) -> Result<()> {
        let per_recipient = amount / ctx.remaining_accounts.len() as u64;
        for account in ctx.remaining_accounts.iter() {
            let transfer_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: account.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            );
            token::transfer(transfer_ctx, per_recipient)?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod fixed_remaining {
    use super::*;

    pub fn distribute(ctx: Context<Distribute>, amount: u64) -> Result<()> {
        let per_recipient = amount / ctx.remaining_accounts.len() as u64;
        for account in ctx.remaining_accounts.iter() {
            // Validate each remaining account is a valid TokenAccount
            let token_account = Account::<TokenAccount>::try_from(account)?;
            require_keys_eq!(token_account.mint, ctx.accounts.vault.mint);

            let transfer_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: account.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            );
            token::transfer(transfer_ctx, per_recipient)?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    expected: {
      vulnClass: "remaining_accounts",
      severity: "HIGH",
      instruction: "distribute",
    },
  },

  {
    id: "fix-token-mismatch",
    vulnClass: "token_authority_mismatch",
    name: "Token Authority Mismatch",
    description: "Token account without authority constraint allows substitution",
    vulnerableSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_token_mismatch {
    use super::*;

    pub fn swap(ctx: Context<Swap>, amount_in: u64) -> Result<()> {
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount_in)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub source_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod fixed_token_mismatch {
    use super::*;

    pub fn swap(ctx: Context<Swap>, amount_in: u64) -> Result<()> {
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount_in)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
    )]
    pub source_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    expected: {
      vulnClass: "token_authority_mismatch",
      severity: "HIGH",
      instruction: "swap",
      accountName: "source_token",
    },
  },

  {
    id: "fix-missing-owner",
    vulnClass: "missing_owner",
    name: "UncheckedAccount Without Validation",
    description: "Mutable UncheckedAccount with no constraint or owner check",
    vulnerableSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_missing_owner {
    use super::*;

    pub fn update_config(ctx: Context<UpdateConfig>, new_fee: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let data = &mut config.try_borrow_mut_data()?;
        data[8..16].copy_from_slice(&new_fee.to_le_bytes());
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// CHECK: No owner or address check — VULNERABLE
    #[account(mut)]
    pub config: AccountInfo<'info>,
    pub admin: Signer<'info>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[account]
pub struct Config {
    pub fee: u64,
    pub admin: Pubkey,
}

#[program]
pub mod fixed_missing_owner {
    use super::*;

    pub fn update_config(ctx: Context<UpdateConfig>, new_fee: u64) -> Result<()> {
        ctx.accounts.config.fee = new_fee;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}
`.trim(),
    expected: {
      vulnClass: "missing_owner",
      severity: "HIGH",
      instruction: "update_config",
      accountName: "config",
    },
  },

  {
    id: "fix-integer-overflow",
    vulnClass: "integer_overflow",
    name: "Unchecked Arithmetic in Fee Calculation",
    description: "Unchecked multiplication in token fee computation",
    vulnerableSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod vuln_overflow {
    use super::*;

    pub fn collect_fee(ctx: Context<CollectFee>, amount: u64, fee_bps: u64) -> Result<()> {
        // VULNERABLE: unchecked multiplication can overflow
        let fee_amount = amount * fee_bps / 10000;
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.fee_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, fee_amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CollectFee<'info> {
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_vault: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod fixed_overflow {
    use super::*;

    pub fn collect_fee(ctx: Context<CollectFee>, amount: u64, fee_bps: u64) -> Result<()> {
        let fee_amount = (amount as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(error!(ErrorCode::MathOverflow))?
            .checked_div(10000)
            .ok_or(error!(ErrorCode::MathOverflow))? as u64;
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.fee_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, fee_amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CollectFee<'info> {
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_vault: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Math overflow")]
    MathOverflow,
}
`.trim(),
    expected: {
      vulnClass: "integer_overflow",
      severity: "HIGH",
      instruction: "collect_fee",
    },
  },

  {
    id: "fix-close-revive",
    vulnClass: "close_revive",
    name: "Account Close Without Zeroing",
    description: "Account closed by draining lamports without zeroing data, allowing revival",
    vulnerableSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[account]
pub struct UserState {
    pub authority: Pubkey,
    pub balance: u64,
}

#[program]
pub mod vuln_close {
    use super::*;

    pub fn close_account(ctx: Context<CloseAccount>) -> Result<()> {
        let dest = &ctx.accounts.destination;
        let source = &ctx.accounts.user_state;
        // VULNERABLE: drains lamports but doesn't zero data
        **dest.to_account_info().try_borrow_mut_lamports()? += source.to_account_info().lamports();
        **source.to_account_info().try_borrow_mut_lamports()? = 0;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CloseAccount<'info> {
    #[account(mut, has_one = authority)]
    pub user_state: Account<'info, UserState>,
    #[account(mut)]
    pub destination: SystemAccount<'info>,
    pub authority: Signer<'info>,
}
`.trim(),
    fixedSource: `
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[account]
pub struct UserState {
    pub authority: Pubkey,
    pub balance: u64,
}

#[program]
pub mod fixed_close {
    use super::*;

    pub fn close_account(_ctx: Context<CloseAccount>) -> Result<()> {
        // Anchor's close constraint handles zeroing + lamport transfer
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CloseAccount<'info> {
    #[account(mut, has_one = authority, close = destination)]
    pub user_state: Account<'info, UserState>,
    #[account(mut)]
    pub destination: SystemAccount<'info>,
    pub authority: Signer<'info>,
}
`.trim(),
    expected: {
      vulnClass: "close_revive",
      severity: "HIGH",
      instruction: "close_account",
    },
  },
];

// ─── Fixture Generator ──────────────────────────────────────

/**
 * Write synthetic fixtures to disk as Anchor project structure.
 */
export function generateFixturesOnDisk(outputDir: string): void {
  for (const fixture of SYNTHETIC_FIXTURES) {
    const vulnDir = join(outputDir, fixture.id, "vulnerable", "programs", "test", "src");
    const fixedDir = join(outputDir, fixture.id, "fixed", "programs", "test", "src");
    const metaDir = join(outputDir, fixture.id);

    mkdirSync(vulnDir, { recursive: true });
    mkdirSync(fixedDir, { recursive: true });

    writeFileSync(join(vulnDir, "lib.rs"), fixture.vulnerableSource);
    writeFileSync(join(fixedDir, "lib.rs"), fixture.fixedSource);

    // Write expected findings
    writeFileSync(
      join(metaDir, "expected.json"),
      JSON.stringify(fixture.expected, null, 2),
    );

    // Write minimal Cargo.toml for parsing
    const cargoToml = `[package]
name = "test-${fixture.id}"
version = "0.1.0"
edition = "2021"

[dependencies]
anchor-lang = "0.29.0"
anchor-spl = "0.29.0"
`;
    writeFileSync(join(outputDir, fixture.id, "vulnerable", "programs", "test", "Cargo.toml"), cargoToml);
    writeFileSync(join(outputDir, fixture.id, "fixed", "programs", "test", "Cargo.toml"), cargoToml);
  }

  console.log(`Generated ${SYNTHETIC_FIXTURES.length} synthetic fixtures in ${outputDir}`);
}