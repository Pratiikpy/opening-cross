//! Governed graduation (ADR-0656): a cross whose creator set `FLAG_GOVERNED_GRADUATION` before its first order can open a
//! pool only at the venue a holder vote chose.
//!
//! The vote is `cross_graduate`'s. Its outcome is a PDA of that program, `["outcome", cross]`, holding the cross and the
//! venue that won. Every seeding instruction passes the cross's rule flags through [`require_approved`]: an ungoverned
//! cross is untouched (no extra account, no extra cost beyond reading one flag), a governed one must name its outcome as
//! the **last remaining account**, and the outcome must be the real PDA, owned by `cross_graduate`, for this cross and
//! this venue. The flag is set in `cross_core`'s rules, which only the creator can write and only before the first order, so
//! the creator cannot add the requirement later and cannot remove it afterwards.
use anchor_lang::prelude::*;

use crate::SettleError;

/// `cross_graduate`'s program id.
pub const GRADUATE_PROGRAM: Pubkey = pubkey!("47f6BhDPCxmW9C9DuuMS2VnbCoU4wnSvjReEwy9Zdke7");
pub const OUTCOME_SEED: &[u8] = b"outcome";
/// `sha256("account:Outcome")[..8]`: the discriminator `cross_graduate` writes. A host test checks it against that crate.
pub const OUTCOME_DISCRIMINATOR: [u8; 8] = [131, 46, 145, 156, 166, 15, 46, 131];
/// `cross_core::ext::FLAG_GOVERNED_GRADUATION`.
pub const FLAG_GOVERNED_GRADUATION: u16 = 1 << 5;
/// Size of a cross account's body: discriminator plus the `Cross` struct (`cross_core::ext::CROSS_BODY`).
pub const CROSS_BODY: usize = 668;
const TAIL_VERSION: u8 = 1;
const TAIL_FLAGS: usize = 10;

/// The venues a vote chooses between, numbered as `cross_graduate` numbers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Venue {
    DammV2 = 0,
    Dlmm = 1,
    RaydiumCpmm = 2,
    Futarchy = 3,
}

/// Whether the cross's rules carry `FLAG_GOVERNED_GRADUATION`. A cross without a rules tail (made by the first version of
/// `cross_core`), with rules never set, or with another tail version is not governed.
pub fn governed(cross_data: &[u8]) -> bool {
    let Some(tail) = cross_data.get(CROSS_BODY..) else {
        return false;
    };
    if tail.first().copied() != Some(TAIL_VERSION) || tail.get(1).copied() != Some(1) {
        return false;
    }
    tail.get(TAIL_FLAGS..TAIL_FLAGS + 2)
        .and_then(|b| <[u8; 2]>::try_from(b).ok())
        .map(u16::from_le_bytes)
        .is_some_and(|f| f & FLAG_GOVERNED_GRADUATION != 0)
}

/// Refuses to seed `venue` for `cross` unless the cross is ungoverned or a passed vote chose that venue.
/// `remaining` is the instruction's remaining accounts; for a governed cross the last one is the outcome.
pub fn require_approved(
    cross: &AccountInfo,
    remaining: &[AccountInfo],
    venue: Venue,
) -> Result<()> {
    if !governed(&cross.try_borrow_data()?) {
        return Ok(());
    }
    let outcome = remaining.last().ok_or(SettleError::GraduationNotApproved)?;
    let (expected, _) =
        Pubkey::find_program_address(&[OUTCOME_SEED, cross.key.as_ref()], &GRADUATE_PROGRAM);
    require_keys_eq!(outcome.key(), expected, SettleError::GraduationNotApproved);
    require_keys_eq!(
        *outcome.owner,
        GRADUATE_PROGRAM,
        SettleError::GraduationNotApproved
    );
    let data = outcome.try_borrow_data()?;
    // discriminator (8), cross (32), venue (1)
    require!(
        data.len() >= 41
            && data[..8] == OUTCOME_DISCRIMINATOR
            && data[8..40] == cross.key.to_bytes()
            && data[40] == venue as u8,
        SettleError::GraduationNotApproved
    );
    Ok(())
}

/// How many remaining accounts a seeding instruction takes besides its own: one more for a governed cross.
pub fn extra_accounts(cross: &AccountInfo) -> Result<usize> {
    Ok(usize::from(governed(&cross.try_borrow_data()?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    #[test]
    fn the_layout_this_module_reads_is_cross_cores_and_cross_graduates() {
        assert_eq!(CROSS_BODY, ::core_program::ext::CROSS_BODY);
        assert_eq!(TAIL_VERSION, ::core_program::ext::EXT_VERSION);
        assert_eq!(
            FLAG_GOVERNED_GRADUATION,
            ::core_program::ext::FLAG_GOVERNED_GRADUATION
        );
        assert_eq!(GRADUATE_PROGRAM, ::graduate_program::ID);
        assert_eq!(
            OUTCOME_DISCRIMINATOR,
            <::graduate_program::Outcome as anchor_lang::Discriminator>::DISCRIMINATOR
        );
        assert_eq!(Venue::DammV2 as u8, 0);
        assert_eq!(Venue::Dlmm as u8, 1);
        assert_eq!(Venue::RaydiumCpmm as u8, 2);
        assert_eq!(Venue::Futarchy as u8, 3);
    }

    #[test]
    fn governed_is_read_from_the_rules_flags() {
        let encode = |flags: u16, rules_set: bool, version: u8| {
            let ext = ::core_program::ext::CrossExt {
                version,
                rules_set,
                flags,
                ..Default::default()
            };
            let mut data = vec![0u8; CROSS_BODY];
            ext.serialize(&mut data).unwrap();
            data
        };
        assert!(governed(&encode(FLAG_GOVERNED_GRADUATION, true, 1)));
        assert!(governed(&encode(
            FLAG_GOVERNED_GRADUATION | ::core_program::ext::FLAG_STANDARD_GRID,
            true,
            1
        )));
        assert!(!governed(&encode(
            ::core_program::ext::FLAG_STANDARD_GRID,
            true,
            1
        )));
        assert!(!governed(&encode(FLAG_GOVERNED_GRADUATION, false, 1)));
        assert!(!governed(&encode(FLAG_GOVERNED_GRADUATION, true, 2)));
        assert!(!governed(&vec![0u8; CROSS_BODY]));
        assert!(!governed(&[]));
    }
}
