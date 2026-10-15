//! Reading the payload of a live Solana Attestation Service attestation.
//!
//! `sas_attestation` validates the account and returns its keys and expiry; the identity and
//! accreditation records this gate reads also need the attestation's `data` bytes. SAS has already
//! checked those bytes against the schema layout when the attestation was created, so a
//! fixed-width layout can be read at fixed offsets.
use anchor_lang::prelude::*;
use sas_attestation::{attestation_address, parse, SAS_PROGRAM_ID};

/// Where the `u32` payload length sits in an attestation account: discriminator `u8`, then the
/// nonce, credential and schema keys.
const DATA_LEN_AT: usize = 97;
const DATA_AT: usize = DATA_LEN_AT + 4;

/// A live attestation's payload and expiry (`0` never expires).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Live {
    pub data: Vec<u8>,
    pub expiry: i64,
}

/// The `data` bytes of attestation account data, or `None` if it is not an attestation or is cut
/// short.
pub fn payload(raw: &[u8]) -> Option<&[u8]> {
    // `parse` checks the discriminator and that the whole account is present.
    parse(raw)?;
    let len = usize::try_from(u32::from_le_bytes(
        raw.get(DATA_LEN_AT..DATA_AT)?.try_into().ok()?,
    ))
    .ok()?;
    raw.get(DATA_AT..DATA_AT.checked_add(len)?)
}

/// `Some(Some(live))` if `info` is a live SAS attestation for `nonce` under `credential` and
/// `schema`; `Some(None)` if it is the right address but missing, closed, foreign or expired;
/// `None` if `info` is not the expected attestation address at all (the caller passed the wrong
/// account).
pub fn read_valid(
    info: &AccountInfo,
    credential: &Pubkey,
    schema: &Pubkey,
    nonce: &Pubkey,
    now: i64,
) -> Option<Option<Live>> {
    if info.key() != attestation_address(credential, schema, nonce) {
        return None;
    }
    if info.owner != &SAS_PROGRAM_ID || info.data_is_empty() {
        return Some(None);
    }
    let raw = info.try_borrow_data().ok()?;
    Some(live_from(&raw, credential, schema, nonce, now))
}

fn live_from(
    raw: &[u8],
    credential: &Pubkey,
    schema: &Pubkey,
    nonce: &Pubkey,
    now: i64,
) -> Option<Live> {
    let a = parse(raw)?;
    let live = a.nonce == *nonce
        && a.credential == *credential
        && a.schema == *schema
        && (a.expiry == 0 || a.expiry > now);
    if !live {
        return None;
    }
    Some(Live {
        data: payload(raw)?.to_vec(),
        expiry: a.expiry,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sas_attestation::ATTESTATION_DISCRIMINATOR;

    fn account(n: Pubkey, c: Pubkey, s: Pubkey, data: &[u8], expiry: i64) -> Vec<u8> {
        let mut v = vec![ATTESTATION_DISCRIMINATOR];
        v.extend_from_slice(n.as_ref());
        v.extend_from_slice(c.as_ref());
        v.extend_from_slice(s.as_ref());
        v.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        v.extend_from_slice(data);
        v.extend_from_slice(Pubkey::new_unique().as_ref());
        v.extend_from_slice(&expiry.to_le_bytes());
        v.extend_from_slice(Pubkey::default().as_ref());
        v
    }

    #[test]
    fn payload_is_read_at_the_declared_length() {
        let (n, c, s) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        for data in [&[][..], &[7u8; 3][..], &[1u8; 44][..]] {
            assert_eq!(payload(&account(n, c, s, data, 5)), Some(data));
        }
        assert_eq!(payload(&[]), None);
        // A credential or schema account is not an attestation.
        let mut other = account(n, c, s, &[1], 0);
        other[0] = 1;
        assert_eq!(payload(&other), None);
        // A length that runs past the end of the account is refused.
        let mut cut = account(n, c, s, &[1, 2, 3], 0);
        cut[DATA_LEN_AT..DATA_AT].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(payload(&cut), None);
    }

    #[test]
    fn live_requires_matching_keys_and_a_future_expiry() {
        let (n, c, s) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let raw = account(n, c, s, &[9, 9], 100);
        let live = live_from(&raw, &c, &s, &n, 99).unwrap();
        assert_eq!((live.data, live.expiry), (vec![9, 9], 100));
        assert!(live_from(&raw, &c, &s, &n, 100).is_none());
        assert!(live_from(&raw, &Pubkey::new_unique(), &s, &n, 0).is_none());
        assert!(live_from(&raw, &c, &Pubkey::new_unique(), &n, 0).is_none());
        assert!(live_from(&raw, &c, &s, &Pubkey::new_unique(), 0).is_none());
        let forever = account(n, c, s, &[], 0);
        assert!(live_from(&forever, &c, &s, &n, i64::MAX).is_some());
    }
}
