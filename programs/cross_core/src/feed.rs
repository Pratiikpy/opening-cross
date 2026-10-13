//! Lender price feed (ADR-0451, PRODUCT_FEATURES W8): "a thin cross never feeds lenders".
//!
//! A lending market that wants a reopen price reads one account, `PrintFeed`, and nothing else.
//! The feed only moves when a registered publisher's cross printed with at least the feed's
//! minimum matched volume and no halt in force, so a cross that barely printed, a wash cross from
//! a stranger, or a print on a halted asset cannot move a lender's collateral price.
use anchor_lang::prelude::*;

use crate::{state::Protocol, CrossError};

pub const FEED_SEED: &[u8] = b"print_feed";
pub const MAX_PUBLISHERS: usize = 4;

#[account]
#[derive(InitSpace)]
pub struct PrintFeed {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// May change the publishers and the minimum.
    pub authority: Pubkey,
    pub publishers: [Pubkey; MAX_PUBLISHERS],
    pub publisher_count: u8,
    /// A print matching less than this many base atoms never updates the feed.
    pub min_matched: u64,
    /// Last accepted print: quote atoms per `price_scale` base atoms.
    pub price: u64,
    pub price_scale: u64,
    pub matched: u64,
    pub cross: Pubkey,
    pub ts: i64,
    pub slot: u64,
    pub prints: u64,
    pub bump: u8,
}

impl PrintFeed {
    pub fn is_publisher(&self, creator: &Pubkey) -> bool {
        self.publishers
            .iter()
            .take(usize::from(self.publisher_count))
            .any(|p| p == creator)
    }

    /// Whether a print of `matched` base atoms may move the feed.
    pub fn accepts(&self, creator: &Pubkey, matched: u128) -> bool {
        self.is_publisher(creator) && matched >= u128::from(self.min_matched)
    }
}

/// Verifies that `account` is the feed of `base_mint`/`quote_mint` and returns it.
pub fn load(account: &AccountInfo, base_mint: &Pubkey, quote_mint: &Pubkey) -> Result<PrintFeed> {
    require_keys_eq!(*account.owner, crate::ID, CrossError::FeedMismatch);
    let data = account.try_borrow_data()?;
    let f = PrintFeed::try_deserialize(&mut &data[..])?;
    require!(
        f.base_mint == *base_mint && f.quote_mint == *quote_mint,
        CrossError::FeedMismatch
    );
    let (pda, _) = Pubkey::find_program_address(&[FEED_SEED, base_mint.as_ref()], &crate::ID);
    require_keys_eq!(pda, account.key(), CrossError::FeedMismatch);
    Ok(f)
}

pub fn store(account: &AccountInfo, feed: &PrintFeed) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data[..];
    feed.try_serialize(&mut cursor)
}

#[derive(Accounts)]
pub struct InitPrintFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the base mint; its mint authority must be the signer, or the signer the protocol admin.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the quote mint the feed is denominated in; only its address is stored.
    pub quote_mint: UncheckedAccount<'info>,
    #[account(seeds = [crate::state::PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, Protocol>,
    #[account(init, payer = authority, space = 8 + PrintFeed::INIT_SPACE, seeds = [FEED_SEED, base_mint.key().as_ref()], bump)]
    pub feed: Account<'info, PrintFeed>,
    pub system_program: Program<'info, System>,
}

pub fn init_print_feed(
    ctx: Context<InitPrintFeed>,
    publishers: Vec<Pubkey>,
    min_matched: u64,
) -> Result<()> {
    let mint = &ctx.accounts.base_mint;
    require!(
        *mint.owner == anchor_spl::token::ID || *mint.owner == anchor_spl::token_2022::ID,
        CrossError::WrongMint
    );
    let signer = ctx.accounts.authority.key();
    let is_admin = signer == ctx.accounts.protocol.admin;
    let is_mint_authority =
        crate::halt::mint_authority_of(&mint.try_borrow_data()?) == Some(signer);
    require!(is_admin || is_mint_authority, CrossError::Unauthorized);
    let f = &mut ctx.accounts.feed;
    f.base_mint = mint.key();
    f.quote_mint = ctx.accounts.quote_mint.key();
    f.authority = signer;
    set_publishers_inner(f, &publishers)?;
    f.min_matched = min_matched;
    f.price = 0;
    f.price_scale = 0;
    f.matched = 0;
    f.cross = Pubkey::default();
    f.ts = 0;
    f.slot = 0;
    f.prints = 0;
    f.bump = ctx.bumps.feed;
    Ok(())
}

fn set_publishers_inner(f: &mut PrintFeed, publishers: &[Pubkey]) -> Result<()> {
    require!(
        !publishers.is_empty() && publishers.len() <= MAX_PUBLISHERS,
        CrossError::InvalidParams
    );
    f.publishers = [Pubkey::default(); MAX_PUBLISHERS];
    for (slot, p) in f.publishers.iter_mut().zip(publishers) {
        *slot = *p;
    }
    f.publisher_count = u8::try_from(publishers.len()).map_err(|_| CrossError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct FeedAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ CrossError::Unauthorized)]
    pub feed: Account<'info, PrintFeed>,
}

pub fn set_feed_publishers(
    ctx: Context<FeedAuthority>,
    publishers: Vec<Pubkey>,
    min_matched: u64,
) -> Result<()> {
    let f = &mut ctx.accounts.feed;
    set_publishers_inner(f, &publishers)?;
    f.min_matched = min_matched;
    Ok(())
}

#[event]
pub struct PrintFed {
    pub base_mint: Pubkey,
    pub cross: Pubkey,
    pub price: u64,
    pub matched: u64,
}
