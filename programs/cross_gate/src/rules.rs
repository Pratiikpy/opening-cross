//! Compliance rules for a gate (ADR-0900).
//!
//! The rules live in an extension region of the gate's `GateConfig` account, after the bytes the
//! original layout uses, so every old reader and every old instruction keeps working and can ask
//! one question of the account it already holds: are rules active? The functions here are pure so
//! they can be tested natively.
use anchor_lang::prelude::*;

use crate::{GateError, SasRequirement};

/// First byte of the extension region. Written by `init_rules`.
pub const EXT_MAGIC: u8 = 0xE1;
/// ISO 3166-1 numeric codes run 0..=999.
pub const COUNTRY_BITS: usize = 1000;
pub const COUNTRY_BYTES: usize = 125;
pub const MAX_BLACKOUTS: usize = 4;

/// Terms flag bits (the same bits appear in the SAS identity attestation, `oc-identity` v1).
pub const FLAG_ACCREDITED: u8 = 1;
pub const FLAG_AFFILIATE: u8 = 1 << 1;
pub const FLAG_SANCTIONS_CLEAR: u8 = 1 << 2;
pub const FLAG_KYC: u8 = 1 << 3;
/// Bits 4..=7 are reserved and must be zero.
pub const FLAGS_KNOWN: u8 = FLAG_ACCREDITED | FLAG_AFFILIATE | FLAG_SANCTIONS_CLEAR | FLAG_KYC;

/// Where a pass came from.
pub const SOURCE_AUTHORITY: u8 = 0;
pub const SOURCE_SAS: u8 = 1;
pub const SOURCE_MERKLE: u8 = 2;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CountryPolicy {
    /// No country rule.
    Off,
    /// Only listed countries may hold the token.
    Allow,
    /// Listed countries may not hold the token.
    Deny,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct TimeWindow {
    pub start: i64,
    pub end: i64,
}

impl TimeWindow {
    pub fn contains(&self, ts: i64) -> bool {
        self.start < self.end && ts >= self.start && ts < self.end
    }
}

/// Rule-144-style volume limit for affiliate-flagged wallets: at most `max_amount` token atoms
/// may leave such a wallet in any `window_secs` window.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct AffiliateLimit {
    pub window_secs: i64,
    pub max_amount: u64,
}

/// Resale lock applied to tokens a wallet receives from a gated cross.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct LockPolicy {
    pub duration_secs: i64,
}

/// The issuer's rules for who may hold the token and how. `passes` is a counter the program
/// maintains; everything else is set by the gate authority.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub struct Rules {
    pub version: u8,
    pub country_policy: CountryPolicy,
    /// Bit `n` set = ISO 3166-1 numeric code `n` is on the list.
    pub countries: [u8; COUNTRY_BYTES],
    /// Minimum tier (0 = any). Tiers: 1 retail, 2 accredited or professional, 3 qualified.
    pub min_tier: u8,
    /// Flags every holder must carry.
    pub required_flags: u8,
    /// A second wallet of an identity that already holds a live pass is refused.
    pub one_identity_one_pass: bool,
    /// Investor cap: live passes may not exceed this (0 = no cap).
    pub max_passes: u32,
    /// Live passes issued under these rules. Maintained by the program.
    pub passes: u32,
    /// Per-identity cap in quote atoms applied when a wallet's terms carry none (0 = no cap).
    pub default_cap: u64,
    /// Passes can only be issued inside this window (0 = unbounded on that side).
    pub issuance_start: i64,
    pub issuance_end: i64,
    /// Issuer-signed identity attestations (`oc-identity` v1) that entitle a wallet to a pass.
    pub identity: Option<SasRequirement>,
    /// Issuer-signed accreditation attestations (`oc-accreditation` v1).
    pub accreditation: Option<SasRequirement>,
    /// Merkle root of terms-bearing allowlist leaves.
    pub allowlist_root: Option<[u8; 32]>,
    pub lock_policy: Option<LockPolicy>,
    /// May call `set_lock` (never weakening) besides the authority: a keeper that applies resale
    /// locks.
    pub lock_delegate: Option<Pubkey>,
    /// Transfers by affiliate-flagged wallets are refused inside these windows.
    pub blackouts: [TimeWindow; MAX_BLACKOUTS],
    pub affiliate_limit: Option<AffiliateLimit>,
    pub reserved: [u8; 32],
}

impl Rules {
    pub const VERSION: u8 = 1;

    /// Bytes of the extension region: the magic byte and the rules.
    pub const EXT_SIZE: usize = 1 + Self::INIT_SPACE;

    pub fn listed(&self, code: u16) -> bool {
        let c = usize::from(code);
        c < COUNTRY_BITS
            && self
                .countries
                .get(c / 8)
                .is_some_and(|b| (b >> (c % 8)) & 1 == 1)
    }

    /// `true` if the affiliate-only transfer rules are configured (the hook then needs the
    /// source's terms and volume accounts).
    pub fn has_transfer_rules(&self) -> bool {
        self.affiliate_limit.is_some() || self.blackouts.iter().any(|w| w.start < w.end)
    }

    /// Structural checks on rules the authority submits.
    pub fn validate(&self) -> Result<()> {
        require!(self.version == Self::VERSION, GateError::BadRules);
        require!(self.required_flags & !FLAGS_KNOWN == 0, GateError::BadRules);
        require!(self.min_tier <= 3, GateError::BadRules);
        require!(
            self.issuance_end == 0
                || self.issuance_start == 0
                || self.issuance_start < self.issuance_end,
            GateError::BadRules
        );
        for w in &self.blackouts {
            require!(
                (w.start == 0 && w.end == 0) || w.start < w.end,
                GateError::BadRules
            );
        }
        if let Some(l) = self.affiliate_limit {
            require!(l.window_secs > 0 && l.max_amount > 0, GateError::BadRules);
        }
        if let Some(l) = self.lock_policy {
            require!(l.duration_secs > 0, GateError::BadRules);
        }
        Ok(())
    }

    /// Does a wallet with these terms satisfy the country, tier and flag rules right now? This is
    /// the part that can change after issuance (the authority edits the rules), so it is shared by
    /// issuance and by the permissionless `revoke_nonconforming`.
    pub fn conforms(&self, t: &TermsData) -> Result<()> {
        match self.country_policy {
            CountryPolicy::Off => {}
            CountryPolicy::Allow | CountryPolicy::Deny => {
                // A country the attester could not establish cannot be shown to satisfy a list.
                require!(t.country != 0, GateError::CountryUnknown);
                let listed = self.listed(t.country);
                if self.country_policy == CountryPolicy::Allow {
                    require!(listed, GateError::CountryNotAllowed);
                } else {
                    require!(!listed, GateError::CountryNotAllowed);
                }
            }
        }
        require!(t.tier >= self.min_tier, GateError::TierTooLow);
        require!(
            t.flags & self.required_flags == self.required_flags,
            GateError::MissingFlags
        );
        Ok(())
    }

    /// The per-identity cap in force for these terms: the wallet's own, else the gate default.
    pub fn cap_for(&self, t_cap: u64) -> u64 {
        if t_cap > 0 {
            t_cap
        } else {
            self.default_cap
        }
    }
}

/// The terms a pass carries. Also the instruction argument that supplies them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct TermsData {
    /// Identity id (all zero = none): unique per person per attester, never PII.
    pub identity: [u8; 32],
    /// ISO 3166-1 numeric (0 = unknown).
    pub country: u16,
    pub tier: u8,
    pub flags: u8,
    /// Per-identity cap in quote atoms per cross (0 = use the gate default).
    pub cap: u64,
    /// The pass lapses at this unix time (0 = never).
    pub expires_ts: i64,
}

impl TermsData {
    pub fn validate(&self) -> Result<()> {
        require!(self.flags & !FLAGS_KNOWN == 0, GateError::BadTerms);
        require!(self.tier <= 3, GateError::BadTerms);
        require!(
            usize::from(self.country) < COUNTRY_BITS,
            GateError::BadTerms
        );
        Ok(())
    }

    pub fn has_identity(&self) -> bool {
        self.identity != [0u8; 32]
    }
}

/// Fixed layout of an `oc-identity` v1 attestation payload (little-endian), as SAS validated it
/// against the schema layout `[U128, U128, U16, U8, U8, U64]`:
/// `identity[32] ‖ country u16 ‖ tier u8 ‖ flags u8 ‖ cap u64`.
pub const IDENTITY_DATA_LEN: usize = 44;

pub fn parse_identity_data(data: &[u8], expires_ts: i64) -> Option<TermsData> {
    if data.len() != IDENTITY_DATA_LEN {
        return None;
    }
    let identity: [u8; 32] = data.get(0..32)?.try_into().ok()?;
    let country = u16::from_le_bytes(data.get(32..34)?.try_into().ok()?);
    let tier = *data.get(34)?;
    let flags = *data.get(35)?;
    let cap = u64::from_le_bytes(data.get(36..44)?.try_into().ok()?);
    Some(TermsData {
        identity,
        country,
        tier,
        flags,
        cap,
        expires_ts,
    })
}

/// Merkle leaf for a terms-bearing allowlist entry. Domain byte `0x02` separates it from the
/// plain allowlist leaf (`0x00`) and inner nodes (`0x01`).
pub fn terms_leaf(mint: &Pubkey, owner: &Pubkey, t: &TermsData) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        &[2u8],
        mint.as_ref(),
        owner.as_ref(),
        &t.identity,
        &t.country.to_le_bytes(),
        &[t.tier],
        &[t.flags],
        &t.cap.to_le_bytes(),
        &t.expires_ts.to_le_bytes(),
    ])
    .to_bytes()
}

/// Reads the rules out of a gate config account's data, or `None` if the account has no active
/// extension.
pub fn read_rules(data: &[u8], ext_offset: usize) -> Result<Option<Rules>> {
    match data.get(ext_offset) {
        Some(&EXT_MAGIC) => {
            let mut body = data
                .get(ext_offset.saturating_add(1)..)
                .ok_or(GateError::BadRules)?;
            Ok(Some(
                Rules::deserialize(&mut body).map_err(|_| GateError::BadRules)?,
            ))
        }
        _ => Ok(None),
    }
}

/// Writes the rules into the extension region (which must already be allocated).
pub fn write_rules(data: &mut [u8], ext_offset: usize, rules: &Rules) -> Result<()> {
    let end = ext_offset
        .checked_add(Rules::EXT_SIZE)
        .ok_or(GateError::BadRules)?;
    let region = data.get_mut(ext_offset..end).ok_or(GateError::BadRules)?;
    region.fill(0);
    let (magic, mut body) = region.split_first_mut().ok_or(GateError::BadRules)?;
    *magic = EXT_MAGIC;
    rules
        .serialize(&mut body)
        .map_err(|_| error!(GateError::BadRules))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        Rules {
            version: Rules::VERSION,
            country_policy: CountryPolicy::Off,
            countries: [0; COUNTRY_BYTES],
            min_tier: 0,
            required_flags: 0,
            one_identity_one_pass: true,
            max_passes: 0,
            passes: 0,
            default_cap: 0,
            issuance_start: 0,
            issuance_end: 0,
            identity: None,
            accreditation: None,
            allowlist_root: None,
            lock_policy: None,
            lock_delegate: None,
            blackouts: [TimeWindow::default(); MAX_BLACKOUTS],
            affiliate_limit: None,
            reserved: [0; 32],
        }
    }

    fn terms(country: u16, tier: u8, flags: u8) -> TermsData {
        TermsData {
            identity: [7; 32],
            country,
            tier,
            flags,
            cap: 0,
            expires_ts: 0,
        }
    }

    fn list(r: &mut Rules, codes: &[u16]) {
        for &c in codes {
            r.countries[usize::from(c) / 8] |= 1u8 << (c % 8);
        }
    }

    #[test]
    fn country_allow_and_deny_lists() {
        let mut r = rules();
        list(&mut r, &[356, 840]); // India, United States
        r.country_policy = CountryPolicy::Deny;
        assert!(r.conforms(&terms(356, 1, 0)).is_err());
        assert!(r.conforms(&terms(840, 1, 0)).is_err());
        assert!(r.conforms(&terms(826, 1, 0)).is_ok());
        r.country_policy = CountryPolicy::Allow;
        assert!(r.conforms(&terms(356, 1, 0)).is_ok());
        assert!(r.conforms(&terms(826, 1, 0)).is_err());
        // Unknown country satisfies neither kind of list.
        assert!(r.conforms(&terms(0, 1, 0)).is_err());
        r.country_policy = CountryPolicy::Deny;
        assert!(r.conforms(&terms(0, 1, 0)).is_err());
        r.country_policy = CountryPolicy::Off;
        assert!(r.conforms(&terms(0, 1, 0)).is_ok());
    }

    #[test]
    fn country_list_edges() {
        let mut r = rules();
        list(&mut r, &[0, 7, 8, 999]);
        assert!(r.listed(0) && r.listed(7) && r.listed(8) && r.listed(999));
        assert!(!r.listed(1) && !r.listed(998) && !r.listed(1000) && !r.listed(u16::MAX));
    }

    #[test]
    fn tier_and_flags() {
        let mut r = rules();
        r.min_tier = 2;
        r.required_flags = FLAG_ACCREDITED | FLAG_SANCTIONS_CLEAR;
        assert!(r
            .conforms(&terms(1, 1, FLAG_ACCREDITED | FLAG_SANCTIONS_CLEAR))
            .is_err());
        assert!(r.conforms(&terms(1, 2, FLAG_ACCREDITED)).is_err());
        assert!(r
            .conforms(&terms(
                1,
                2,
                FLAG_ACCREDITED | FLAG_SANCTIONS_CLEAR | FLAG_KYC
            ))
            .is_ok());
    }

    #[test]
    fn validate_rejects_malformed_rules() {
        let mut r = rules();
        assert!(r.validate().is_ok());
        r.required_flags = 0x80;
        assert!(r.validate().is_err());
        let mut r = rules();
        r.min_tier = 4;
        assert!(r.validate().is_err());
        let mut r = rules();
        r.blackouts[0] = TimeWindow { start: 10, end: 5 };
        assert!(r.validate().is_err());
        let mut r = rules();
        r.affiliate_limit = Some(AffiliateLimit {
            window_secs: 0,
            max_amount: 1,
        });
        assert!(r.validate().is_err());
        let mut r = rules();
        r.version = 2;
        assert!(r.validate().is_err());
    }

    #[test]
    fn rules_round_trip_through_the_extension_region() {
        let mut r = rules();
        list(&mut r, &[356]);
        r.country_policy = CountryPolicy::Allow;
        r.identity = Some(SasRequirement {
            credential: Pubkey::new_unique(),
            schema: Pubkey::new_unique(),
        });
        r.lock_policy = Some(LockPolicy {
            duration_secs: 31_536_000,
        });
        r.blackouts[1] = TimeWindow {
            start: 100,
            end: 200,
        };
        let mut data = vec![0xAAu8; 300 + Rules::EXT_SIZE];
        assert!(read_rules(&data, 300).unwrap().is_none());
        write_rules(&mut data, 300, &r).unwrap();
        assert_eq!(read_rules(&data, 300).unwrap(), Some(r.clone()));
        // The original layout's bytes are untouched.
        assert!(data[..300].iter().all(|&b| b == 0xAA));
        // A shorter account has no extension.
        assert!(read_rules(&data[..300], 300).unwrap().is_none());
        // Rewriting with options cleared leaves no stale bytes that change the result.
        let mut r2 = r.clone();
        r2.identity = None;
        r2.lock_policy = None;
        write_rules(&mut data, 300, &r2).unwrap();
        assert_eq!(read_rules(&data, 300).unwrap(), Some(r2));
    }

    #[test]
    fn identity_data_parses_exactly_44_bytes() {
        let mut d = vec![0u8; IDENTITY_DATA_LEN];
        d[..32].copy_from_slice(&[9u8; 32]);
        d[32..34].copy_from_slice(&356u16.to_le_bytes());
        d[34] = 2;
        d[35] = FLAG_KYC | FLAG_SANCTIONS_CLEAR;
        d[36..44].copy_from_slice(&5_000_000u64.to_le_bytes());
        let t = parse_identity_data(&d, 1234).unwrap();
        assert_eq!(t.identity, [9u8; 32]);
        assert_eq!(
            (t.country, t.tier, t.cap, t.expires_ts),
            (356, 2, 5_000_000, 1234)
        );
        assert_eq!(t.flags, FLAG_KYC | FLAG_SANCTIONS_CLEAR);
        assert!(parse_identity_data(&d[..43], 0).is_none());
        d.push(0);
        assert!(parse_identity_data(&d, 0).is_none());
    }

    #[test]
    fn terms_validation() {
        let mut t = terms(356, 1, FLAG_KYC);
        assert!(t.validate().is_ok());
        t.flags = 0x10;
        assert!(t.validate().is_err());
        let mut t = terms(1000, 1, 0);
        assert!(t.validate().is_err());
        t.country = 999;
        assert!(t.validate().is_ok());
        t.tier = 4;
        assert!(t.validate().is_err());
    }

    #[test]
    fn leaf_is_bound_to_every_field() {
        let (mint, owner) = (Pubkey::new_unique(), Pubkey::new_unique());
        let t = terms(356, 2, FLAG_KYC);
        let base = terms_leaf(&mint, &owner, &t);
        assert_ne!(base, terms_leaf(&Pubkey::new_unique(), &owner, &t));
        assert_ne!(base, terms_leaf(&mint, &Pubkey::new_unique(), &t));
        for mutate in [
            |t: &mut TermsData| t.identity[0] ^= 1,
            |t: &mut TermsData| t.country += 1,
            |t: &mut TermsData| t.tier += 1,
            |t: &mut TermsData| t.flags ^= FLAG_AFFILIATE,
            |t: &mut TermsData| t.cap += 1,
            |t: &mut TermsData| t.expires_ts += 1,
        ] {
            let mut u = t;
            mutate(&mut u);
            assert_ne!(base, terms_leaf(&mint, &owner, &u));
        }
    }
}
