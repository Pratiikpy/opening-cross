// Devnet proof for the gate user path (W3, G6, G4): a gated cross where a wallet without a pass is refused with the diagnostic, and
// wallets that obtained a pass through the product's own API bid and are filled, read back from chain.
//
//  - Gate: one cross_gate config with BOTH routes: a Merkle allowlist root (alice) and a SAS requirement issued by the devnet test attester (bob).
//  - API: services/api/src/routes/gate.ts, run in-process against the real devnet RPC (the same code the live API runs once it is mounted).
//  - Attester: services/identity-attester, configured through the same environment variables and key files an operator would use.
//    The attester's check is "the wallet signed a challenge": it verifies no identity.
//  - Wallets sign the unsigned transactions the API builds, exactly as a browser wallet would.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:gate-live
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import {
  type Address,
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signBytes,
  signTransaction,
} from '@solana/kit';
import { Mode, findConfigPda, getCreateConfigInstruction, getSetAllowlistRootInstruction, getSetSasRequirementInstruction } from '@opening-cross/cross-gate-client';
import { CrossState, OrderSide, buildClaim, buildFinalize, buildPlaceOrder, buildSettleBook, gatePassAddress, orderAddress, protocolAddress } from '@opening-cross/sdk';
import { Evidence, ROOT, rpc } from './lib.js';
import { crossView, ensureFeeRecipientAccount, prepareLaunch } from './cross-helpers.js';
import { balanceOf, chainTime, exists, freshFunder, fundWallets, mintTo, mustFail, newMint, send, sleep, sweepBack, waitUntil } from './kit.js';
import { registerGate } from '@opening-cross/api/src/routes/gate.js';
import { RequestError } from '@opening-cross/api/src/tx.js';
import { buildAllowlist } from '@opening-cross/presets/gate-allowlist';
import { buildAttester } from '@opening-cross/identity-attester/src/server.js';
import { createChain, issueAttestation } from '@opening-cross/identity-attester/src/chain.js';
import { loadSettings } from '@opening-cross/identity-attester/src/config.js';

const ev = new Evidence('W3-gate-claim-devnet.md', 'Devnet proof: the gate user path, from refusal with a diagnostic to a pass, a bid and a fill (W3, G6, G4)', [
  'Script `tests/devnet/src/gate-live-proof.ts` (`dp:gate-live`). Every transaction is a real devnet transaction; expected refusals are simulated against the deployed program, so no failed transaction is billed or recorded.',
  'The gate has two routes at once: a Merkle allowlist (alice) and a SAS requirement issued by the devnet test attester (bob). Carol is on neither.',
  'The API code under test is `services/api/src/routes/gate.ts`, run in-process against devnet; the attester is `services/identity-attester`, started from key files through its environment variables. The attester is a **devnet test attester: it verifies that a wallet signed a challenge, nothing about identity.** Throwaway keys only; the proof writes them under the git-ignored `.keys/`.',
  '',
  'Not covered: the HTTP mounting in the live API process (the coordinator wires `registerGate` into `server.ts`); the Postgres allowlist store (this run uses an in-memory store); a real KYC or accredited-investor provider (HUMAN_TASKS HI2, HG2); browser wallet signing (the wallet here is a local key).',
]);

let cleanup: (() => Promise<void>) | undefined;

/** A fresh Ed25519 keypair as the 64 bytes a Solana keyfile holds (generateKeyPairSigner keys cannot be exported). */
async function freshKeyBytes(): Promise<Uint8Array> {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return new Uint8Array([...pkcs8.slice(-32), ...raw]);
}

async function landUnsigned(b64: string, wallet: KeyPairSigner): Promise<string> {
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(b64, 'base64')));
  const signed = await signTransaction([wallet.keyPair], tx);
  const sig = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 90; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await sleep(1_000);
  }
  throw new Error(`transaction ${sig} was not confirmed`);
}

async function main() {
  const { funder: issuer, promiser } = await freshFunder(330_000_000n);
  cleanup = async () => {
    const back = await sweepBack(issuer, promiser);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
  };
  const [alice, bob, carol] = await Promise.all([1, 2, 3].map(() => generateKeyPairSigner()));
  const attesterBytes = await freshKeyBytes();
  const attesterKey = await createKeyPairSignerFromBytes(attesterBytes);
  await fundWallets(issuer, [alice!.address, bob!.address, carol!.address, attesterKey.address], 12_000_000n);

  // ---- the attester, configured the way an operator would: key files named by environment variables.
  const keyFile = `${ROOT}.keys/gate-live-attester-${attesterKey.address.slice(0, 6)}.json`;
  const secretFile = `${ROOT}.keys/gate-live-attester-${attesterKey.address.slice(0, 6)}.secret`;
  writeFileSync(keyFile, JSON.stringify([...attesterBytes]));
  writeFileSync(secretFile, randomBytes(32).toString('hex'));
  const settings = await loadSettings({ ATTESTER_KEYPAIR: keyFile, ATTESTER_SECRET_FILE: secretFile, RPC_URL: process.env.RPC_URL ?? 'https://api.devnet.solana.com', ATTESTATION_TTL_SECONDS: '7200' });
  ev.check('attester-config', 'the attester loads its key and challenge secret from files named by environment variables', settings.signer.address === attesterKey.address, `attester ${settings.signer.address}; key files under .keys/ (git-ignored), not printed`);
  const chain = createChain(settings.rpcUrl);
  const init = await chain.init(settings.signer);
  ev.check('attester-init', 'the attester creates its SAS credential and schema with the Solana Attestation Service\'s own instructions', (await exists(init.credential)) && (await exists(init.schema)), `credential ${init.credential}, schema ${init.schema}`, init.signatures[0]);
  const attesterApp = await buildAttester({
    credential: init.credential,
    schema: init.schema,
    attester: settings.signer.address,
    secret: settings.secret,
    ttlSeconds: settings.ttlSeconds,
    hourlyCap: settings.hourlyCap,
    issue: (wallet) => issueAttestation({ chain, signer: settings.signer, credential: init.credential, schema: init.schema, wallet, ttlSeconds: settings.ttlSeconds }),
  });
  const info = (await attesterApp.inject({ method: 'GET', url: '/v1/attester' })).json();
  ev.check('attester-label', 'the attester states that it verifies no identity', info.label === 'devnet test attester: no real identity verification' && info.notChecked.includes('accredited-investor status'), `label "${info.label}"; not checked: ${info.notChecked.join(', ')}`);

  // ---- the gate: allowlist for alice, SAS requirement for the attester's credential.
  const gateMint = await newMint(issuer, issuer.address);
  const [config] = await findConfigPda({ mint: gateMint });
  const tree = buildAllowlist(gateMint, [alice!.address]);
  const cfgSig = await send(
    [
      getCreateConfigInstruction({ payer: issuer, mintAuthority: issuer, mint: gateMint, config, authority: issuer.address, mode: Mode.Allowlist }),
      getSetSasRequirementInstruction({ authority: issuer, config, sas: { credential: init.credential, schema: init.schema } }),
      getSetAllowlistRootInstruction({ authority: issuer, config, root: tree.root }),
    ],
    issuer,
  );
  ev.check('gate', 'a cross_gate config holds both an allowlist root and the attester\'s SAS requirement', await exists(config), `gate mint ${gateMint}, root ${tree.rootHex}`, cfgSig);

  // ---- a gated cross
  const protocol = await protocolAddress();
  if (!(await exists(protocol))) throw new Error('cross_core protocol singleton missing on devnet; run dp:core first');
  const quoteMint = await newMint(issuer, issuer.address);
  for (const w of [alice!, bob!, carol!]) await mintTo(issuer, quoteMint, w.address, issuer, 10_000_000_000n);
  await mintTo(issuer, quoteMint, issuer.address, issuer, 1_000_000_000_000n);
  const closeTs = (await chainTime()) + 260n;
  const { cross, baseMint, built } = await prepareLaunch({ issuer, quoteMint, closeTs, gateMint });
  const createSig = await send([built.create, ...built.shards], issuer);
  const cv = await crossView(cross);
  ev.check('gated-cross', 'a cross is created bound to the gate mint', cv.data.gateMint.__option === 'Some' && cv.data.gateMint.value === gateMint, `cross ${cross}`, createSig);

  // ---- the API, in-process, reading devnet
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
    return reply.code(500).send({ error: String(err) });
  });
  const memory = new Map<string, { rootHex: string; addresses: Address[] }>();
  registerGate(app, {
    db: { query: async () => ({ rows: [{ address: cross }] }) } as never,
    account: async (a) => {
      const { value } = await rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
      return value ? { data: new Uint8Array(Buffer.from(value.data[0], 'base64')), owner: value.owner } : null;
    },
    lifetime: async () => {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return value;
    },
    allowlists: { get: async (m) => memory.get(m) ?? null, put: async (m, rootHex, addresses) => void memory.set(m, { rootHex, addresses }) },
  });
  await app.ready();
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: r.json() };
  };
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: r.json() };
  };
  const codes = (b: { reasons: { code: string }[] }) => b.reasons.map((r) => r.code);
  const elig = (w: KeyPairSigner) => get(`/v1/eligibility/${cross}/${w.address}`);

  const found = await get('/v1/gates');
  const mine = found.body.gates.find((g: { mint: string }) => g.mint === gateMint);
  ev.check('discover', 'GET /v1/gates finds the gate from the cross and reports both routes', found.status === 200 && mine?.allowlistRoot === tree.rootHex && mine?.sas?.credential === init.credential && mine.routes.map((r: { kind: string }) => r.kind).join() === 'allowlist,attestation,authority', JSON.stringify(mine?.routes?.map((r: { kind: string }) => r.kind)));

  // ---- before any pass: everybody is refused, with a reason that says what would fix it
  const a0 = await elig(alice!);
  ev.check('diag-alice-unpublished', 'alice is on the allowlist but the issuer has not published it: the diagnostic says no proof can be built yet', !a0.body.eligible && codes(a0.body).includes('ALLOWLIST_NOT_PUBLISHED') && codes(a0.body).includes('NO_ATTESTATION'), codes(a0.body).join(', '));
  const b0 = await elig(bob!);
  const noAtt = b0.body.reasons.find((r: { code: string }) => r.code === 'NO_ATTESTATION');
  ev.check('diag-bob-no-attestation', 'bob has no attestation: the diagnostic names the credential and the nonce that would satisfy it', !b0.body.eligible && !!noAtt && noAtt.fix.includes(init.credential) && noAtt.fix.includes(bob!.address), noAtt?.fix ?? 'no NO_ATTESTATION reason');
  const place = async (w: KeyPairSigner) => buildPlaceOrder({ cross: await crossView(cross), owner: w, nonce: 0n, side: OrderSide.Buy, price: 1_200_000n, quantity: 500_000_000n });
  const refusal = await mustFail([await place(carol!)], carol!, 'NotEligible');
  const c0 = await elig(carol!);
  ev.check('refuse-carol', 'a wallet without a pass is refused by the program with NotEligible, and the API names why on both routes', c0.body.eligible === false && codes(c0.body).includes('ALLOWLIST_NOT_PUBLISHED') && codes(c0.body).includes('NO_ATTESTATION'), `${refusal}; diagnostic: ${codes(c0.body).join(', ')}`);
  const claimEarly = await post('/v1/tx/claim-pass', { mint: gateMint, owner: carol!.address });
  ev.check('claim-refused-with-reasons', 'asking for a claim transaction when there is nothing to claim answers 422 with the same reasons and no transaction', claimEarly.status === 422 && !claimEarly.body.transaction && claimEarly.body.reasons.length > 0, `HTTP ${claimEarly.status}: ${claimEarly.body.error}`);

  // ---- alice: the issuer publishes the list; the API builds the proof transaction
  const wrongList = await post(`/v1/gates/${gateMint}/allowlist`, { addresses: [alice!.address, carol!.address] });
  ev.check('publish-wrong-list', 'a list that does not hash to the root on chain is not accepted', wrongList.status === 409 && wrongList.body.chainRoot === tree.rootHex, `HTTP ${wrongList.status}: ${wrongList.body.error}`);
  const pub = await post(`/v1/gates/${gateMint}/allowlist`, { addresses: [alice!.address] });
  ev.check('publish-list', 'the list whose root is on chain is published', pub.status === 200 && pub.body.published === true && pub.body.root === tree.rootHex, `HTTP ${pub.status}, root ${pub.body.root}`);
  const a1 = await elig(alice!);
  ev.check('diag-alice-claimable', 'alice is now told she can claim', a1.body.canClaim === true && codes(a1.body).includes('CLAIMABLE_BY_ALLOWLIST'), codes(a1.body).join(', '));
  const c1 = await elig(carol!);
  ev.check('diag-carol-not-listed', 'carol, not on the published list, is told so, and that only the issuer can change it', codes(c1.body).includes('NOT_ON_ALLOWLIST') && c1.body.reasons.find((r: { code: string }) => r.code === 'NOT_ON_ALLOWLIST').fix.includes('Only the issuer'), codes(c1.body).join(', '));
  const aTx = await post('/v1/tx/claim-pass', { mint: gateMint, owner: alice!.address });
  const aSig = await landUnsigned(aTx.body.transaction, alice!);
  const alicePass = await gatePassAddress(gateMint, alice!.address);
  ev.check('claim-allowlist', 'alice signs the transaction the API built and her pass exists on chain (claim_pass_merkle)', aTx.status === 200 && (await exists(alicePass)), `pass ${alicePass}, proof length ${aTx.body.proofLength}`, aSig);

  // ---- bob: the attester checks wallet control, then the API builds the attestation claim
  const challenge = (await attesterApp.inject({ method: 'GET', url: `/v1/attester/challenge?wallet=${bob!.address}` })).json();
  const signature = Buffer.from(await signBytes(bob!.keyPair.privateKey, new TextEncoder().encode(challenge.message))).toString('base64');
  const forged = await attesterApp.inject({ method: 'POST', url: '/v1/attester/attest', payload: { wallet: bob!.address, issuedAt: challenge.issuedAt, signature: Buffer.alloc(64).toString('base64') } });
  ev.check('attester-refuses-forgery', 'the attester refuses a signature that is not the wallet\'s', forged.statusCode === 403, `HTTP ${forged.statusCode}: ${forged.json().error}`);
  const attested = await attesterApp.inject({ method: 'POST', url: '/v1/attester/attest', payload: { wallet: bob!.address, issuedAt: challenge.issuedAt, signature } });
  const att = attested.json();
  ev.check('attest', 'after bob signs the challenge the attester writes a SAS attestation for his wallet', attested.statusCode === 200 && (await exists(att.attestation)), `attestation ${att.attestation}, expires ${att.expiry}, label "${att.label}"`, att.signature);
  const b1 = await elig(bob!);
  ev.check('diag-bob-claimable', 'bob is now told he can claim with his attestation', b1.body.canClaim === true && codes(b1.body).includes('CLAIMABLE_BY_ATTESTATION') && b1.body.sas.state === 'live', codes(b1.body).join(', '));
  const bTx = await post('/v1/tx/claim-pass', { mint: gateMint, owner: bob!.address });
  const bSig = await landUnsigned(bTx.body.transaction, bob!);
  const bobPass = await gatePassAddress(gateMint, bob!.address);
  ev.check('claim-attestation', 'bob signs the transaction the API built and his pass exists on chain (claim_pass)', bTx.status === 200 && (await exists(bobPass)), `pass ${bobPass}`, bSig);
  const again = await post('/v1/tx/claim-pass', { mint: gateMint, owner: bob!.address });
  ev.check('claim-twice', 'a second claim for the same wallet answers 409 and no transaction', again.status === 409 && !again.body.transaction, `HTTP ${again.status}: ${again.body.error}`);

  // ---- bids: pass holders place orders; carol is still refused
  const aliceBid = await send([await place(alice!)], alice!);
  ev.check('bid-alice', 'alice (allowlist pass) places an order in the gated cross', await exists(await orderAddress(cross, alice!.address, 0n)), 'order account exists', aliceBid);
  const bobBid = await send([await place(bob!)], bob!);
  ev.check('bid-bob', 'bob (attestation pass) places an order in the gated cross', await exists(await orderAddress(cross, bob!.address, 0n)), 'order account exists', bobBid);
  const refusal2 = await mustFail([await place(carol!)], carol!, 'NotEligible');
  ev.check('bid-carol-refused', 'carol is still refused after the others claimed', true, refusal2);
  const a2 = await elig(alice!);
  const b2 = await elig(bob!);
  ev.check('diag-after', 'the diagnostic now reports alice and bob eligible', a2.body.eligible === true && b2.body.eligible === true && codes(a2.body)[0] === 'HAS_PASS', `alice ${codes(a2.body).join(',')}; bob ${codes(b2.body).join(',')}`);

  // ---- settle and read the fills back from chain
  await waitUntil(closeTs + 1n);
  let last = '';
  for (const ix of await buildSettleBook(await crossView(cross))) last = await send([ix], issuer);
  const cleared = await crossView(cross);
  ev.check('clear', 'the gated cross clears with the two pass holders as its only buyers', cleared.data.state === CrossState.Cleared && cleared.data.clearing.__option === 'Some', cleared.data.clearing.__option === 'Some' ? `P* ${cleared.data.clearing.value.price}, matched ${cleared.data.clearing.value.matched}` : 'no clearing', last);
  for (const [name, w] of [['alice', alice!], ['bob', bob!]] as const) {
    const sig = await send(await buildClaim(await crossView(cross), issuer, w.address, 0n), issuer);
    const got = await balanceOf(w.address, baseMint);
    ev.check(`fill-${name}`, `${name} receives a fill, read from the chain`, got > 0n, `${name} holds ${got} base atoms`, sig);
  }
  const carolGot = await balanceOf(carol!.address, baseMint).catch(() => 0n);
  ev.check('fill-carol-none', 'carol, who could not bid, holds none of the new token', carolGot === 0n, `carol holds ${carolGot} base atoms`);
  await ensureFeeRecipientAccount(issuer, quoteMint);
  const finSig = await send([await buildFinalize(await crossView(cross), issuer)], issuer);
  ev.check('finalize', 'the gated cross finalises', (await crossView(cross)).data.state === CrossState.Finalized, 'state Finalized', finSig);
}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => ev.write(error));
main().then(() => done(), (e) => { console.error(e); return done(e); });
