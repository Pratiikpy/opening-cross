//! Solana Attestation Service (SAS) attestation accounts, read without the SAS crate.
//!
//! An attestation lives at the PDA `[b"attestation", credential, schema, nonce]` of the SAS
//! program and is laid out as: discriminator `u8` (2) · nonce · credential · schema · data
//! (`u32` length + bytes) · signer · expiry `i64` · token account. `expiry == 0` never expires.
#![forbid(unsafe_code)]

use anchor_lang::prelude::*;

pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
/// `AttestationAccountDiscriminators::AttestationDiscriminator`.
pub const ATTESTATION_DISCRIMINATOR: u8 = 2;
pub const ATTESTATION_SEED: &[u8] = b"attestation";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub nonce: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub expiry: i64,
}

/// The attestation address for `nonce` under a credential and schema.
pub fn attestation_address(credential: &Pubkey, schema: &Pubkey, nonce: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            ATTESTATION_SEED,
            credential.as_ref(),
            schema.as_ref(),
            nonce.as_ref(),
        ],
        &SAS_PROGRAM_ID,
    )
    .0
}

/// Parses attestation account data; `None` for anything that is not one.
pub fn parse(d: &[u8]) -> Option<Attestation> {
    if *d.first()? != ATTESTATION_DISCRIMINATOR {
        return None;
    }
    let key = |at: usize| -> Option<Pubkey> {
        Some(Pubkey::new_from_array(
            d.get(at..at.checked_add(32)?)?.try_into().ok()?,
        ))
    };
    let nonce = key(1)?;
    let credential = key(33)?;
    let schema = key(65)?;
    let len = usize::try_from(u32::from_le_bytes(d.get(97..101)?.try_into().ok()?)).ok()?;
    let expiry_at = 101usize.checked_add(len)?.checked_add(32)?;
    let expiry = i64::from_le_bytes(
        d.get(expiry_at..expiry_at.checked_add(8)?)?
            .try_into()
            .ok()?,
    );
    Some(Attestation {
        nonce,
        credential,
        schema,
        expiry,
    })
}

/// `Some(true)` if `info` is a live SAS attestation for `nonce` under `credential`/`schema`;
/// `Some(false)` if it is the right address but missing, closed, foreign or expired; `None` if
/// `info` is not the expected attestation address at all (the caller passed the wrong account).
pub fn is_valid(
    info: &AccountInfo,
    credential: &Pubkey,
    schema: &Pubkey,
    nonce: &Pubkey,
    now: i64,
) -> Option<bool> {
    if info.key() != attestation_address(credential, schema, nonce) {
        return None;
    }
    if info.owner != &SAS_PROGRAM_ID || info.data_is_empty() {
        return Some(false);
    }
    let data = info.try_borrow_data().ok()?;
    Some(parse(&data).is_some_and(|a| {
        a.nonce == *nonce
            && a.credential == *credential
            && a.schema == *schema
            && (a.expiry == 0 || a.expiry > now)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(
        nonce: Pubkey,
        credential: Pubkey,
        schema: Pubkey,
        data: &[u8],
        expiry: i64,
    ) -> Vec<u8> {
        let mut v = vec![ATTESTATION_DISCRIMINATOR];
        v.extend_from_slice(nonce.as_ref());
        v.extend_from_slice(credential.as_ref());
        v.extend_from_slice(schema.as_ref());
        v.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        v.extend_from_slice(data);
        v.extend_from_slice(Pubkey::new_unique().as_ref()); // signer
        v.extend_from_slice(&expiry.to_le_bytes());
        v.extend_from_slice(Pubkey::default().as_ref()); // token account
        v
    }

    #[test]
    fn parses_fields_after_variable_length_data() {
        let (n, c, s) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        for data in [&[][..], &[7u8; 3][..], &[1u8; 200][..]] {
            assert_eq!(
                parse(&bytes(n, c, s, data, 1234)),
                Some(Attestation {
                    nonce: n,
                    credential: c,
                    schema: s,
                    expiry: 1234
                })
            );
        }
    }

    #[test]
    fn rejects_other_accounts_and_truncation() {
        let mut b = bytes(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            &[1, 2],
            0,
        );
        assert!(parse(&b[..b.len() - 40]).is_none());
        b[0] = 1; // a credential or schema account
        assert!(parse(&b).is_none());
        assert!(parse(&[]).is_none());
    }
}
