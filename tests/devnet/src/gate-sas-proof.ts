// Devnet proof for cross_gate identity gating with a real Solana Attestation Service attestation (ROADMAP C5).
// An issuer creates a credential, a schema and attestations with SAS's own instructions on devnet; the
// attested wallet claims a gate pass, wallets without a valid attestation are refused, expiry and closure
// let anyone revoke, and a cross_core cross bound to the gate admits only the attested wallet.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:gate
import { type Address, generateKeyPairSigner } from '@solana/kit';
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
import { CrossState, OrderSide, buildClaim, buildFinalize, buildPlaceOrder, buildSettleBook, gatePassAddress, orderAddress, protocolAddress } from '@opening-cross/sdk';
import { Evidence, rpc } from './lib.js';
import { crossView, ensureFeeRecipientAccount, prepareLaunch } from './cross-helpers.js';
import { asIx, balanceOf, chainTime, exists, fundWallets, freshFunder, mintTo, mustFail, newMint, send, sweepBack, waitUntil } from './kit.js';

const SAS_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;

const ev = new Evidence('C5-gate-sas-devnet.md', 'Devnet proof — cross_gate identity gating with a real SAS attestation (C5)', [
  'Script `tests/devnet/src/gate-sas-proof.ts` (`dp:gate`). Every transaction is a real devnet transaction; expected refusals are simulated against the deployed program, so no failed transaction is billed or recorded.',
  `SAS program \`${SAS_ADDRESS}\` · cross_gate \`2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr\` · cross_core \`F5k8…\` (see the cross address below)`,
  'Roles: one throwaway issuer/gate-admin key funded from the devnet promiser key, and four throwaway user wallets (alice attested, bob never attested, carol attested with a short expiry, dave attested then closed).',
  '',
  'Not covered: the issuer is a throwaway key, so this proves the mechanism and not any real KYC provider (HUMAN H2: choosing which SAS issuers to trust). Merkle-allowlist passes and the hook/Token ACL gating of transfers are proved elsewhere (`token-acl-proof.ts`, `tests/core/test/sas.test.ts`).',
]);
let cleanup: (() => Promise<void>) | undefined;

async function main() {
  // 1. SAS exists on devnet.
  const sasInfo = await rpc.getAccountInfo(SAS_ADDRESS, { encoding: 'base64', commitment: 'confirmed' }).send();
  ev.check('sas-present', 'the Solana Attestation Service program is deployed and executable on devnet at its published address', Boolean(sasInfo.value?.executable), `owner ${sasInfo.value?.owner}`);
  if (!sasInfo.value?.executable) throw new Error('SAS is not deployed on this cluster');

  const { funder: issuer, promiser } = await freshFunder(240_000_000n);
  cleanup = async () => {
    const back = await sweepBack(issuer, promiser);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
  };
  const [alice, bob, carol, dave, stranger] = await Promise.all([1, 2, 3, 4, 5].map(() => generateKeyPairSigner()));
  await fundWallets(issuer, [alice!.address, bob!.address, carol!.address, dave!.address, stranger!.address], 8_000_000n);

  // 2. Credential and schema, created with SAS's own instructions.
  const name = `opening-kyc-${Date.now()}`;
  const [credential] = await deriveCredentialPda({ authority: issuer.address, name });
  const [schema] = await deriveSchemaPda({ credential, name: 'kyc-pass', version: 1 });
  const credSig = await send([asIx(getCreateCredentialInstruction({ payer: issuer, credential, authority: issuer, name, signers: [issuer.address] } as never))], issuer);
  const schemaSig = await send([asIx(getCreateSchemaInstruction({ payer: issuer, authority: issuer, credential, schema, name: 'kyc-pass', description: 'KYC passed', layout: new Uint8Array([0]), fieldNames: ['level'] } as never))], issuer);
  ev.check('credential', 'SAS credential created by the issuer', await exists(credential), `credential ${credential}`, credSig);
  ev.check('schema', 'SAS schema created under the credential', await exists(schema), `schema ${schema}`, schemaSig);

  // 3. A gate for a mint, requiring that credential and schema.
  const gateMint = await newMint(issuer, issuer.address);
  const [config] = await findConfigPda({ mint: gateMint });
  const cfgSig = await send(
    [
      getCreateConfigInstruction({ payer: issuer, mintAuthority: issuer, mint: gateMint, config, authority: issuer.address, mode: Mode.Allowlist }),
      getSetSasRequirementInstruction({ authority: issuer, config, sas: { credential, schema } }),
    ],
    issuer,
  );
  ev.check('gate', 'cross_gate config created for the mint and bound to the SAS credential and schema', await exists(config), `gate mint ${gateMint}, config ${config}`, cfgSig);

  const attest = async (subject: Address, expiry: bigint) => {
    const [attestation] = await deriveAttestationPda({ credential, schema, nonce: subject });
    const sig = await send([asIx(getCreateAttestationInstruction({ payer: issuer, authority: issuer, credential, schema, attestation, nonce: subject, data: new Uint8Array([1]), expiry } as never))], issuer);
    return { attestation, sig };
  };
  const claim = async (subject: Address, attestation: Address) =>
    getClaimPassInstruction({ payer: issuer, owner: subject, config, attestation, pass: await gatePassAddress(gateMint, subject) });

  // 4. Alice: attested, claims a pass.
  const a = await attest(alice!.address, 0n);
  const attAcct = await rpc.getAccountInfo(a.attestation, { encoding: 'base64', commitment: 'confirmed' }).send();
  ev.check('attestation', "alice's SAS attestation exists on devnet, owned by the SAS program", attAcct.value?.owner === SAS_ADDRESS, `attestation ${a.attestation}`, a.sig);
  const claimSig = await send([await claim(alice!.address, a.attestation)], issuer);
  const alicePass = await gatePassAddress(gateMint, alice!.address);
  ev.check('claim-attested', 'an attested wallet claims a gate pass', await exists(alicePass), `pass ${alicePass}`, claimSig);

  // 5. Wallets that must be refused.
  const [bobAtt] = await deriveAttestationPda({ credential, schema, nonce: bob!.address });
  ev.check('refuse-unattested', 'a wallet with no attestation cannot claim a pass', true, await mustFail([await claim(bob!.address, bobAtt)], issuer, 'AttestationInvalid'));
  ev.check('refuse-borrowed', "bob cannot claim with alice's attestation", true, await mustFail([await claim(bob!.address, a.attestation)], issuer, 'AttestationInvalid'));

  // 6. Carol: a short-lived attestation (expiry measured on the cluster's clock).
  const carolExpiry = (await chainTime()) + 150n;
  const c = await attest(carol!.address, carolExpiry);
  const carolClaim = await send([await claim(carol!.address, c.attestation)], issuer);
  const carolPass = await gatePassAddress(gateMint, carol!.address);
  ev.check('claim-expiring', 'a wallet with a not-yet-expired attestation claims a pass', await exists(carolPass), `expiry ${carolExpiry}`, carolClaim);
  const revoke = getRevokeUnattestedInstruction({ config, attestation: c.attestation, owner: carol!.address, pass: carolPass });
  ev.check('revoke-too-early', 'nobody can revoke a pass while its attestation is still valid', true, await mustFail([revoke], stranger!, 'AttestationStillValid'));

  // 7. Dave: attested, then the issuer closes the attestation at SAS.
  const d = await attest(dave!.address, 0n);
  await send([await claim(dave!.address, d.attestation)], issuer);
  const davePass = await gatePassAddress(gateMint, dave!.address);
  const closeSig = await send([asIx(getCloseAttestationInstruction({ payer: issuer, authority: issuer, credential, attestation: d.attestation } as never))], issuer);
  ev.check('attestation-closed', 'the issuer closes the attestation at SAS', !(await exists(d.attestation)), `attestation ${d.attestation}`, closeSig);
  const daveRevoke = await send([getRevokeUnattestedInstruction({ config, attestation: d.attestation, owner: dave!.address, pass: davePass })], stranger!);
  ev.check('revoke-closed', 'any wallet then revokes the pass', !(await exists(davePass)), 'pass account closed', daveRevoke);

  // 8. A cross_core cross bound to the gate admits only the attested wallet.
  const protocol = await protocolAddress();
  if (!(await exists(protocol))) throw new Error('cross_core protocol singleton missing on devnet; run dp:core first');
  const quoteMint = await newMint(issuer, issuer.address);
  await mintTo(issuer, quoteMint, alice!.address, issuer, 10_000_000_000n);
  await mintTo(issuer, quoteMint, bob!.address, issuer, 10_000_000_000n);
  await mintTo(issuer, quoteMint, dave!.address, issuer, 10_000_000_000n);
  await mintTo(issuer, quoteMint, issuer.address, issuer, 1_000_000_000_000n);
  const closeTs = (await chainTime()) + 80n;
  const { cross, baseMint, built } = await prepareLaunch({ issuer, quoteMint, closeTs, gateMint });
  const createSig = await send([built.create, ...built.shards], issuer);
  const cv = await crossView(cross);
  ev.check('gated-cross', 'a cross_core cross is created bound to the gate mint', cv.data.gateMint.__option === 'Some' && cv.data.gateMint.value === gateMint, `cross ${cross}`, createSig);
  const bid = await send([await buildPlaceOrder({ cross: await crossView(cross), owner: alice!, nonce: 0n, side: OrderSide.Buy, price: 1_200_000n, quantity: 500_000_000n })], alice!);
  ev.check('gated-bid-allowed', 'the attested wallet places an order in the gated cross', await exists(await orderAddress(cross, alice!.address, 0n)), 'order account exists', bid);
  ev.check('gated-bid-refused', 'a wallet without a pass is refused with NotEligible', true, await mustFail([await buildPlaceOrder({ cross: await crossView(cross), owner: bob!, nonce: 0n, side: OrderSide.Buy, price: 1_200_000n, quantity: 500_000_000n })], bob!, 'NotEligible'));
  ev.check('gated-bid-revoked-refused', "dave, whose attestation was closed and pass revoked, is refused too", true, await mustFail([await buildPlaceOrder({ cross: await crossView(cross), owner: dave!, nonce: 0n, side: OrderSide.Buy, price: 1_200_000n, quantity: 500_000_000n })], dave!, 'NotEligible'));

  // 9. Settle the gated cross, and let carol's attestation expire while it runs.
  await waitUntil(closeTs + 1n);
  let last = '';
  for (const ix of await buildSettleBook(await crossView(cross))) last = await send([ix], issuer);
  const cleared = await crossView(cross);
  ev.check('gated-clear', 'the gated cross clears with the attested wallet as the only buyer', cleared.data.state === CrossState.Cleared && cleared.data.clearing.__option === 'Some', cleared.data.clearing.__option === 'Some' ? `P* ${cleared.data.clearing.value.price}, matched ${cleared.data.clearing.value.matched}` : 'no clearing', last);
  const claimOrder = await send(await buildClaim(await crossView(cross), issuer, alice!.address, 0n), issuer);
  const got = await balanceOf(alice!.address, baseMint);
  ev.check('gated-claim', 'the attested wallet receives its fill', got > 0n, `alice holds ${got} base atoms`, claimOrder);
  await ensureFeeRecipientAccount(issuer, quoteMint);
  const finSig = await send([await buildFinalize(await crossView(cross), issuer)], issuer);
  ev.check('gated-finalize', 'the gated cross finalises', (await crossView(cross)).data.state === CrossState.Finalized, 'state Finalized', finSig);

  await waitUntil(carolExpiry);
  const rev = await send([revoke], stranger!);
  ev.check('revoke-expired', "after the expiry passes, any wallet revokes carol's pass", !(await exists(carolPass)), `expiry ${carolExpiry}`, rev);
  ev.check('refuse-expired', 'an expired attestation can no longer claim a pass', true, await mustFail([await claim(carol!.address, c.attestation)], issuer, 'AttestationInvalid'));

}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => ev.write(error));
main().then(() => done(), (e) => { console.error(e); return done(e); });
