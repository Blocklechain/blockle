//! Solana leg of the Blockle cross-chain atomic-swap exchange.
//!
//! A non-custodial hash-timelocked contract (HTLC) for **native SOL** and
//! **arbitrary SPL tokens** (USDC + USDT are first-class legs; the mint is a
//! per-swap account, never hardcoded). Funds are escrowed in a per-swap PDA
//! (SOL) or a per-swap vault token account (SPL) and released either to the
//! receiver on preimage reveal, or back to the sender after the timelock.
//!
//! Protocol hash: **SHA-256** (`solana_program::hash` is SHA-256), so the same
//! hashlock `sha256(preimage)` works on the EVM leg too. See `../PROTOCOL.md`.
//!
//! Protocol fee: a configurable basis-point fee is taken ONLY on settlement
//! (`withdraw_*`) and sent to the configured fee wallet. `refund_*` takes no
//! fee. Testnet-first: a `Config` holds `mainnet_enabled` (default false); the
//! money paths are meant to run on devnet until an operator flips it after a
//! recorded legal review (see README).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash as sha256;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("4Lo3YrF77MPGH9UPxGxjwkFfZN5X7Pey6kXYJ1ZzzEdS");

pub const MAX_FEE_BPS: u16 = 100; // 1.00% hard cap

#[program]
pub mod htlc {
    use super::*;

    /// One-time global config: authority, fee wallet, fee bps. `mainnet_enabled`
    /// starts false.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16, fee_wallet: Pubkey) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, HtlcError::BadFee);
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.fee_bps = fee_bps;
        cfg.fee_wallet = fee_wallet;
        cfg.mainnet_enabled = false;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Authority-gated money-path switch. Enabling mainnet is an operator
    /// decision that must follow a recorded legal/compliance review.
    pub fn set_mainnet(ctx: Context<AdminConfig>, enabled: bool) -> Result<()> {
        ctx.accounts.config.mainnet_enabled = enabled;
        Ok(())
    }

    // ---------------- native SOL ----------------

    pub fn lock_sol(
        ctx: Context<LockSol>,
        swap_id: [u8; 32],
        hashlock: [u8; 32],
        timelock: i64,
        receiver: Pubkey,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, HtlcError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        require!(timelock > now, HtlcError::BadParams);

        // Move lamports from sender into the swap PDA (escrow).
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.sender.key(),
            &ctx.accounts.swap.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.sender.to_account_info(),
                ctx.accounts.swap.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let s = &mut ctx.accounts.swap;
        s.sender = ctx.accounts.sender.key();
        s.receiver = receiver;
        s.mint = Pubkey::default(); // native SOL
        s.amount = amount;
        s.hashlock = hashlock;
        s.timelock = timelock;
        s.swap_id = swap_id;
        s.is_native = true;
        s.state = State::Locked as u8;
        s.bump = ctx.bumps.swap;
        emit!(Locked { swap: s.key(), sender: s.sender, receiver, mint: s.mint, amount, hashlock, timelock });
        Ok(())
    }

    pub fn withdraw_sol(ctx: Context<WithdrawSol>, preimage: Vec<u8>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let s = &ctx.accounts.swap;
            require!(s.state == State::Locked as u8, HtlcError::NotLocked);
            require!(s.is_native, HtlcError::WrongKind);
            require!(now < s.timelock, HtlcError::TimelockExpired);
            require!(check_preimage(&preimage, &s.hashlock), HtlcError::InvalidPreimage);
            require_keys_eq!(ctx.accounts.receiver.key(), s.receiver, HtlcError::BadReceiver);
            require_keys_eq!(ctx.accounts.fee_wallet.key(), ctx.accounts.config.fee_wallet, HtlcError::BadFeeWallet);
        }
        let amount = ctx.accounts.swap.amount;
        let fee = (amount as u128 * ctx.accounts.config.fee_bps as u128 / 10_000u128) as u64;
        let payout = amount - fee;

        // Move escrowed lamports out of the swap PDA directly (program-owned).
        **ctx.accounts.swap.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.receiver.to_account_info().try_borrow_mut_lamports()? += payout;
        if fee > 0 {
            **ctx.accounts.fee_wallet.to_account_info().try_borrow_mut_lamports()? += fee;
        }
        ctx.accounts.swap.state = State::Withdrawn as u8;
        emit!(Withdrawn { swap: ctx.accounts.swap.key(), preimage });
        Ok(())
    }

    pub fn refund_sol(ctx: Context<RefundSol>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let s = &ctx.accounts.swap;
            require!(s.state == State::Locked as u8, HtlcError::NotLocked);
            require!(s.is_native, HtlcError::WrongKind);
            require!(now >= s.timelock, HtlcError::TimelockNotExpired);
            require_keys_eq!(ctx.accounts.sender.key(), s.sender, HtlcError::BadSender);
        }
        let amount = ctx.accounts.swap.amount;
        **ctx.accounts.swap.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.sender.to_account_info().try_borrow_mut_lamports()? += amount;
        ctx.accounts.swap.state = State::Refunded as u8;
        emit!(Refunded { swap: ctx.accounts.swap.key() });
        Ok(())
    }

    // ---------------- SPL token ----------------

    pub fn lock_spl(
        ctx: Context<LockSpl>,
        swap_id: [u8; 32],
        hashlock: [u8; 32],
        timelock: i64,
        receiver: Pubkey,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, HtlcError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        require!(timelock > now, HtlcError::BadParams);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
        )?;

        let s = &mut ctx.accounts.swap;
        s.sender = ctx.accounts.sender.key();
        s.receiver = receiver;
        s.mint = ctx.accounts.mint.key();
        s.amount = amount;
        s.hashlock = hashlock;
        s.timelock = timelock;
        s.swap_id = swap_id;
        s.is_native = false;
        s.state = State::Locked as u8;
        s.bump = ctx.bumps.swap;
        emit!(Locked { swap: s.key(), sender: s.sender, receiver, mint: s.mint, amount, hashlock, timelock });
        Ok(())
    }

    pub fn withdraw_spl(ctx: Context<WithdrawSpl>, preimage: Vec<u8>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let s = &ctx.accounts.swap;
            require!(s.state == State::Locked as u8, HtlcError::NotLocked);
            require!(!s.is_native, HtlcError::WrongKind);
            require!(now < s.timelock, HtlcError::TimelockExpired);
            require!(check_preimage(&preimage, &s.hashlock), HtlcError::InvalidPreimage);
            require_keys_eq!(ctx.accounts.receiver_ata.owner, s.receiver, HtlcError::BadReceiver);
            require_keys_eq!(ctx.accounts.fee_ata.owner, ctx.accounts.config.fee_wallet, HtlcError::BadFeeWallet);
        }
        let amount = ctx.accounts.swap.amount;
        let fee = (amount as u128 * ctx.accounts.config.fee_bps as u128 / 10_000u128) as u64;
        let payout = amount - fee;

        let swap_id = ctx.accounts.swap.swap_id;
        let bump = ctx.accounts.swap.bump;
        let seeds: &[&[u8]] = &[b"swap", swap_id.as_ref(), &[bump]];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.receiver_ata.to_account_info(),
                    authority: ctx.accounts.swap.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.fee_ata.to_account_info(),
                        authority: ctx.accounts.swap.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }
        // Close the now-empty vault, reclaiming rent to the sender.
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.sender.to_account_info(),
                authority: ctx.accounts.swap.to_account_info(),
            },
            signer,
        ))?;

        ctx.accounts.swap.state = State::Withdrawn as u8;
        emit!(Withdrawn { swap: ctx.accounts.swap.key(), preimage });
        Ok(())
    }

    pub fn refund_spl(ctx: Context<RefundSpl>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let s = &ctx.accounts.swap;
            require!(s.state == State::Locked as u8, HtlcError::NotLocked);
            require!(!s.is_native, HtlcError::WrongKind);
            require!(now >= s.timelock, HtlcError::TimelockNotExpired);
            require_keys_eq!(ctx.accounts.sender.key(), s.sender, HtlcError::BadSender);
            require_keys_eq!(ctx.accounts.sender_ata.owner, s.sender, HtlcError::BadSender);
        }
        let amount = ctx.accounts.swap.amount;
        let swap_id = ctx.accounts.swap.swap_id;
        let bump = ctx.accounts.swap.bump;
        let seeds: &[&[u8]] = &[b"swap", swap_id.as_ref(), &[bump]];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.sender_ata.to_account_info(),
                    authority: ctx.accounts.swap.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.sender.to_account_info(),
                authority: ctx.accounts.swap.to_account_info(),
            },
            signer,
        ))?;
        ctx.accounts.swap.state = State::Refunded as u8;
        emit!(Refunded { swap: ctx.accounts.swap.key() });
        Ok(())
    }
}

/// SHA-256 preimage check (matches EVM `sha256(preimage)`).
fn check_preimage(preimage: &[u8], hashlock: &[u8; 32]) -> bool {
    sha256(preimage).to_bytes() == *hashlock
}

#[repr(u8)]
pub enum State {
    Locked = 1,
    Withdrawn = 2,
    Refunded = 3,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub fee_wallet: Pubkey,
    pub fee_bps: u16,
    pub mainnet_enabled: bool,
    pub bump: u8,
}
impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 1 + 1;
}

#[account]
pub struct Swap {
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hashlock: [u8; 32],
    pub timelock: i64,
    pub swap_id: [u8; 32],
    pub is_native: bool,
    pub state: u8,
    pub bump: u8,
}
impl Swap {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 32 + 8 + 32 + 1 + 1 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = Config::LEN, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct LockSol<'info> {
    #[account(init, payer = sender, space = Swap::LEN, seeds = [b"swap", swap_id.as_ref()], bump)]
    pub swap: Account<'info, Swap>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut, seeds = [b"swap", swap.swap_id.as_ref()], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: validated against swap.receiver in handler.
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,
    /// CHECK: validated against config.fee_wallet in handler.
    #[account(mut)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundSol<'info> {
    #[account(mut, seeds = [b"swap", swap.swap_id.as_ref()], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
    /// CHECK: validated against swap.sender in handler.
    #[account(mut)]
    pub sender: UncheckedAccount<'info>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct LockSpl<'info> {
    #[account(init, payer = sender, space = Swap::LEN, seeds = [b"swap", swap_id.as_ref()], bump)]
    pub swap: Account<'info, Swap>,
    #[account(
        init,
        payer = sender,
        token::mint = mint,
        token::authority = swap,
        seeds = [b"vault", swap_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut, constraint = sender_ata.mint == mint.key() @ HtlcError::BadMint)]
    pub sender_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawSpl<'info> {
    #[account(mut, seeds = [b"swap", swap.swap_id.as_ref()], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", swap.swap_id.as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = receiver_ata.mint == swap.mint @ HtlcError::BadMint)]
    pub receiver_ata: Account<'info, TokenAccount>,
    #[account(mut, constraint = fee_ata.mint == swap.mint @ HtlcError::BadMint)]
    pub fee_ata: Account<'info, TokenAccount>,
    /// CHECK: receives reclaimed vault rent; validated as swap.sender.
    #[account(mut, address = swap.sender @ HtlcError::BadSender)]
    pub sender: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundSpl<'info> {
    #[account(mut, seeds = [b"swap", swap.swap_id.as_ref()], bump = swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(mut, seeds = [b"vault", swap.swap_id.as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = sender_ata.mint == swap.mint @ HtlcError::BadMint)]
    pub sender_ata: Account<'info, TokenAccount>,
    /// CHECK: receives reclaimed vault rent; validated as swap.sender.
    #[account(mut, address = swap.sender @ HtlcError::BadSender)]
    pub sender: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub caller: Signer<'info>,
}

#[event]
pub struct Locked {
    pub swap: Pubkey,
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub hashlock: [u8; 32],
    pub timelock: i64,
}
#[event]
pub struct Withdrawn {
    pub swap: Pubkey,
    pub preimage: Vec<u8>,
}
#[event]
pub struct Refunded {
    pub swap: Pubkey,
}

#[error_code]
pub enum HtlcError {
    #[msg("fee bps above cap")]
    BadFee,
    #[msg("bad parameters")]
    BadParams,
    #[msg("swap is not in the locked state")]
    NotLocked,
    #[msg("wrong swap kind (native vs spl)")]
    WrongKind,
    #[msg("timelock has expired")]
    TimelockExpired,
    #[msg("timelock has not expired yet")]
    TimelockNotExpired,
    #[msg("invalid preimage")]
    InvalidPreimage,
    #[msg("receiver mismatch")]
    BadReceiver,
    #[msg("sender mismatch")]
    BadSender,
    #[msg("fee wallet mismatch")]
    BadFeeWallet,
    #[msg("mint mismatch")]
    BadMint,
}
