// Identity-gated access with the Solana Attestation Service (ROADMAP C5), against the mainnet
// SAS binary: an issuer creates a credential, schema and attestation with SAS's own
// instructions; the attested wallet can claim a cross_gate pass, a wallet without one cannot,
// and anyone can revoke the pass once the attestation expires or is closed. The pass then gates
// order entry in a cross.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, address } from '@solana/kit';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCloseAttestationInstruction,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import {
  Mode,
  findConfigPda,
  getClaimPassInstruction,
  getCreateConfigInstruction,
  getRevokeUnattestedInstruction,
  getSetSasRequirementInstruction,
} from '@opening-cross/cross-gate-client';
import { OrderSide, buildPlaceOrder, gatePassAddress } from '@opening-cross/sdk';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const SAS = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
const SO = fileURLToPath(new URL('../../fixtures/solana_attestation_service.so', import.meta.url));
const ix = (x: unknown) => x as Instruction; // sas-lib targets kit 5; instructions are plain data

async function setup() {
  const w = await World.create();
  w.h.svm.addProgramFromFile(SAS, SO);
  const issuer = await w.h.wallet();
  const [credential] = await deriveCredentialPda({ authority: issuer.address, name: 'opening-kyc' });
  const [schema] = await deriveSchemaPda({ credential, name: 'kyc-pass', version: 1 });
  await w.h.send([ix(getCreateCredentialInstruction({ payer: issuer, credential, authority: issuer, name: 'opening-kyc', signers: [issuer.address] } as never))], issuer);
  await w.h.send([ix(getCreateSchemaInstruction({ payer: issuer, authority: issuer, credential, schema, name: 'kyc-pass', description: 'KYC passed', layout: new Uint8Array([0]), fieldNames: ['level'] } as never))], issuer);

  const gateMint = await w.h.mint(w.admin, 6);
  const [config] = await findConfigPda({ mint: gateMint });
  await w.h.send(
    [
      getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist }),
      getSetSasRequirementInstruction({ authority: w.admin, config, sas: { credential, schema } }),
    ],
    w.admin,
  );

  const attest = async (subject: Address, expiry: bigint) => {
    const [attestation] = await deriveAttestationPda({ credential, schema, nonce: subject });
    await w.h.send([ix(getCreateAttestationInstruction({ payer: issuer, authority: issuer, credential, schema, attestation, nonce: subject, data: new Uint8Array([1]), expiry } as never))], issuer);
    return attestation;
  };
  const claim = async (subject: Address, attestation: Address) =>
    getClaimPassInstruction({ payer: w.admin, owner: subject, config, attestation, pass: await gatePassAddress(gateMint, subject) });
  return { w, issuer, credential, schema, gateMint, config, attest, claim };
}

describe.skipIf(!existsSync(SO))('SAS-gated passes', () => {
  it('an attested wallet claims a pass and can then trade a gated cross; others cannot', async () => {
    const { w, gateMint, attest, claim, credential, schema } = await setup();
    const alice = await w.trader(10_000_000_000n);
    const bob = await w.trader(10_000_000_000n);
    const att = await attest(alice.address, 0n);
    await w.h.send([await claim(alice.address, att)], w.admin);
    expect(w.h.exists(await gatePassAddress(gateMint, alice.address))).toBe(true);

    // Bob has no attestation: the derived address is empty, so the claim fails.
    const [bobAtt] = await deriveAttestationPda({ credential, schema, nonce: bob.address });
    expect(await w.h.fail([await claim(bob.address, bobAtt)], w.admin)).toContain('AttestationInvalid');
    // Bob cannot reuse Alice's attestation: it is for a different wallet.
    expect(await w.h.fail([await claim(bob.address, att)], w.admin)).toContain('AttestationInvalid');

    const cross = await w.newCross({ gateMint });
    await w.place(cross, alice, OrderSide.Buy, 1_000_000n, 1_000n);
    expect(await w.h.fail([await buildPlaceOrder({ cross: w.view(cross.address), owner: bob, nonce: 9n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n })], bob)).toContain('NotEligible');
  });

  it('expired attestations cannot claim, and expiry lets anyone revoke an existing pass', async () => {
    const { w, gateMint, config, attest, claim } = await setup();
    const carol = await w.trader();
    const att = await attest(carol.address, T0 + 1_000n);
    await w.h.send([await claim(carol.address, att)], w.admin);
    const pass = await gatePassAddress(gateMint, carol.address);
    const stranger = await w.trader();
    const revoke = getRevokeUnattestedInstruction({ config, attestation: att, owner: carol.address, pass });
    expect(await w.h.fail([revoke], stranger)).toContain('AttestationStillValid');
    w.h.setTime(T0 + 1_000n);
    await w.h.send([revoke], stranger);
    expect(w.h.exists(pass)).toBe(false);
    expect(await w.h.fail([await claim(carol.address, att)], w.admin)).toContain('AttestationInvalid');
  });

  it('closing the attestation at SAS lets anyone revoke the pass', async () => {
    const { w, issuer, credential, gateMint, config, attest, claim } = await setup();
    const dave = await w.trader();
    const att = await attest(dave.address, 0n);
    await w.h.send([await claim(dave.address, att)], w.admin);
    await w.h.send([ix(getCloseAttestationInstruction({ payer: issuer, authority: issuer, credential, attestation: att } as never))], issuer);
    const pass = await gatePassAddress(gateMint, dave.address);
    await w.h.send([getRevokeUnattestedInstruction({ config, attestation: att, owner: dave.address, pass })], issuer);
    expect(w.h.exists(pass)).toBe(false);
  });
});

describe('Merkle allowlist passes', () => {
  it('listed wallets claim with a proof; unlisted wallets and forged proofs are refused', async () => {
    const { buildAllowlist } = await import('@opening-cross/sdk');
    const { getClaimPassMerkleInstruction, getSetAllowlistRootInstruction } = await import('@opening-cross/cross-gate-client');
    const w = await World.create();
    const gateMint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint: gateMint });
    const listed = [];
    for (let i = 0; i < 5; i++) listed.push(await w.trader()); // sequential: the harness rotates blockhashes per send
    const { root, proofs } = buildAllowlist(gateMint, listed.map((t) => t.address));
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist }), getSetAllowlistRootInstruction({ authority: w.admin, config, root })], w.admin);
    for (const t of listed) {
      await w.h.send([getClaimPassMerkleInstruction({ payer: w.admin, owner: t.address, config, pass: await gatePassAddress(gateMint, t.address), proof: proofs.get(t.address)! })], w.admin);
      expect(w.h.exists(await gatePassAddress(gateMint, t.address))).toBe(true);
    }
    const outsider = await w.trader();
    expect(await w.h.fail([getClaimPassMerkleInstruction({ payer: w.admin, owner: outsider.address, config, pass: await gatePassAddress(gateMint, outsider.address), proof: proofs.get(listed[0]!.address)! })], w.admin)).toContain('NotOnAllowlist');
    expect(await w.h.fail([getClaimPassMerkleInstruction({ payer: w.admin, owner: outsider.address, config, pass: await gatePassAddress(gateMint, outsider.address), proof: [] })], w.admin)).toContain('NotOnAllowlist');
  });
});
