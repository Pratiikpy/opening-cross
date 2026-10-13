// Issuer builders over HTTP with accounts injected in memory: the fee schedule read, the treasury-creation refusals and the happy
// path (decoded from the transaction it returns), and the disclosure-update steps up to a signed update the existing verifier accepts.
import { beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { type Address, generateKeyPairSigner, getTransactionDecoder, getCompiledTransactionMessageDecoder, decompileTransactionMessage, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import { PROTOCOL_DISCRIMINATOR, findProtocolPda, getProtocolEncoder } from '@opening-cross/cross-core-client';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { TREASURY_PROGRAM_ADDRESS, TreasuryState, findTreasuryPda, getCreateTreasuryInstructionDataDecoder, getTreasuryEncoder } from '@opening-cross/treasury-client';
import { RequestError } from '../src/tx.js';
import { SAS_PROGRAM_ADDRESS, registerIssuerTx } from '../src/routes/issuer-tx.js';
import { SPL_TOKEN, TOKEN_2022 } from '../../../apps/web/src/lib/issuer-readiness';
import { MEMO_PROGRAM, type SignedUpdate, memoTextOf, signUpdate, verifyUpdate } from '../src/routes/treasury-updates.js';

const NOW = 1_800_000_000;
const kp = async () => generateKeyPairSigner();

const mintBytes = (o: { authority: Address | null; supply: bigint; decimals?: number }) =>
  new Uint8Array(getMintEncoder().encode({ mintAuthority: o.authority ? some(o.authority) : none(), supply: o.supply, decimals: o.decimals ?? 6, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));

describe('issuer builders', () => {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const updates: { id: string; sequence: number }[] = [];
  let app: ReturnType<typeof Fastify>;
  let team: Awaited<ReturnType<typeof kp>>;
  let coin: Address, openCoin: Address, emptyCoin: Address, quote: Address, ghost: Address, credential: Address, schema: Address, notSas: Address, treasuryCoin: Address;

  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const valid = () => ({ authority: team.address, coinMint: coin, quoteMint: quote, allowance: '1000000000', periodSecs: 2_592_000, graceSecs: 604_800, credential, schema });

  beforeAll(async () => {
    team = await kp();
    [coin, openCoin, emptyCoin, quote, ghost, credential, schema, notSas, treasuryCoin] = (await Promise.all(Array.from({ length: 9 }, kp))).map((s) => s.address);
    accounts.set(coin, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes({ authority: null, supply: 10_000_000_000n }) });
    accounts.set(openCoin, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes({ authority: team.address, supply: 5n }) });
    accounts.set(emptyCoin, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes({ authority: null, supply: 0n }) });
    accounts.set(quote, { owner: SPL_TOKEN_PROGRAM_ADDRESS, data: mintBytes({ authority: team.address, supply: 1n, decimals: 6 }) });
    accounts.set(credential, { owner: SAS_PROGRAM_ADDRESS, data: new Uint8Array(40) });
    accounts.set(schema, { owner: SAS_PROGRAM_ADDRESS, data: new Uint8Array(40) });
    accounts.set(notSas, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: new Uint8Array(40) });
    accounts.set(treasuryCoin, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes({ authority: null, supply: 1_000n }) });
    const [existing] = await findTreasuryPda({ coinMint: treasuryCoin });
    accounts.set(existing, {
      owner: TREASURY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getTreasuryEncoder().encode({ authority: team.address, coinMint: treasuryCoin, quoteMint: quote, quoteDecimals: 6, allowance: 1n, periodSecs: 60n, periodStart: 0n, spentInPeriod: 0n, credential, schema, graceSecs: 60n, lapsedSince: none(), state: TreasuryState.Active, snapshotVault: 0n, snapshotSupply: 0n, bump: 255, vaultBump: 255 }),
      ),
    });
    const [protocol] = await findProtocolPda();
    accounts.set(protocol, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getProtocolEncoder().encode({ admin: team.address, guardian: team.address, feeRecipient: team.address, feeBps: [30, 5, 15, 30], paused: false, bump: 255, pendingAdmin: none() })) });
    void PROTOCOL_DISCRIMINATOR;

    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
      return reply.code(500).send({ error: String(err) });
    });
    registerIssuerTx(app, {
      account: async (a) => accounts.get(a) ?? null,
      lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n }),
      db: { query: async () => ({ rows: updates.length ? [updates[updates.length - 1]!] : [] }) },
      clock: () => NOW,
      network: 'devnet',
    });
    await app.ready();
  });

  describe('GET /v1/issuer/protocol', () => {
    it('serves the fee schedule per kind from the Protocol account', async () => {
      const { status, body } = await get('/v1/issuer/protocol');
      expect(status).toBe(200);
      expect(body.feeBps).toEqual({ launch: 30, reopen: 5, tender: 15, recurring: 30 });
      expect(body.paused).toBe(false);
      expect(body.maxIntegratorFeeBps).toBe(300);
    });
    it('says 404 when the account is not there or is not the program’s', async () => {
      const [protocol] = await findProtocolPda();
      const kept = accounts.get(protocol)!;
      accounts.set(protocol, { ...kept, owner: TOKEN_2022_PROGRAM_ADDRESS });
      expect((await get('/v1/issuer/protocol')).status).toBe(404);
      accounts.delete(protocol);
      expect((await get('/v1/issuer/protocol')).status).toBe(404);
      accounts.set(protocol, kept);
    });
  });

  describe('POST /v1/tx/create-treasury', () => {
    it('builds the transaction the program expects, with the issuer paying and signing', async () => {
      const { status, body } = await post('/v1/tx/create-treasury', valid());
      expect(status).toBe(200);
      const [treasury] = await findTreasuryPda({ coinMint: coin });
      expect(body.treasury).toBe(treasury);
      expect(body.signers).toEqual([team.address]);
      const tx = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(body.transaction, 'base64')));
      const msg = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
      expect(msg.instructions).toHaveLength(1);
      const ix = msg.instructions[0]!;
      expect(ix.programAddress).toBe(TREASURY_PROGRAM_ADDRESS);
      const data = getCreateTreasuryInstructionDataDecoder().decode(ix.data!);
      expect(data).toMatchObject({ allowance: 1_000_000_000n, periodSecs: 2_592_000n, graceSecs: 604_800n, credential, schema });
      // accounts: authority, coin, quote, treasury, vault, quote token program, system program
      expect(ix.accounts!.map((a) => a.address).slice(0, 3)).toEqual([team.address, coin, quote]);
      expect(ix.accounts![5]!.address).toBe(SPL_TOKEN_PROGRAM_ADDRESS); // the quote mint's own program
    });

    it('refuses a coin whose mint authority is still set, and says what to wait for', async () => {
      const r = await post('/v1/tx/create-treasury', { ...valid(), coinMint: openCoin });
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('SUPPLY_NOT_FIXED');
      expect(r.body.error).toMatch(/wait for the cross to finalize/);
    });
    it('refuses a coin with no supply', async () => {
      expect(await post('/v1/tx/create-treasury', { ...valid(), coinMint: emptyCoin })).toMatchObject({ status: 422, body: { reason: 'NO_SUPPLY' } });
    });
    it('refuses a treasury that already exists', async () => {
      expect(await post('/v1/tx/create-treasury', { ...valid(), coinMint: treasuryCoin })).toMatchObject({ status: 409, body: { reason: 'TREASURY_EXISTS' } });
    });
    it('refuses a credential or schema that is missing or not the attestation service’s', async () => {
      expect(await post('/v1/tx/create-treasury', { ...valid(), credential: ghost })).toMatchObject({ status: 422, body: { reason: 'CREDENTIAL_NOT_FOUND' } });
      expect(await post('/v1/tx/create-treasury', { ...valid(), schema: notSas })).toMatchObject({ status: 422, body: { reason: 'SCHEMA_NOT_SAS' } });
    });
    it('refuses a coin or quote mint that does not exist or is not a mint', async () => {
      expect(await post('/v1/tx/create-treasury', { ...valid(), coinMint: ghost })).toMatchObject({ status: 404, body: { reason: 'COIN_NOT_FOUND' } });
      expect(await post('/v1/tx/create-treasury', { ...valid(), quoteMint: notSas })).toMatchObject({ status: 422, body: { reason: 'QUOTE_NOT_A_MINT' } });
      expect(await post('/v1/tx/create-treasury', { ...valid(), quoteMint: credential })).toMatchObject({ status: 422 });
    });
    it('refuses junk: missing fields, wrong types, zero or absurd numbers', async () => {
      for (const bad of [
        {},
        { ...valid(), authority: 'nope' },
        { ...valid(), allowance: '0' },
        { ...valid(), allowance: '-1' },
        { ...valid(), allowance: '18446744073709551616' },
        { ...valid(), periodSecs: 0 },
        { ...valid(), periodSecs: 1.5 },
        { ...valid(), periodSecs: 10 * 365 * 86_400 + 1 },
        { ...valid(), graceSecs: -1 },
        { ...valid(), quoteMint: coin },
      ])
        expect((await post('/v1/tx/create-treasury', bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/v1/tx/create-treasury', payload: '[1]', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    });
  });

  describe('disclosure update steps', () => {
    const base = () => ({ title: 'October update', summary: 'We spent on hosting and one hire.', coveredFrom: NOW - 86_400, coveredTo: NOW - 60, declaredSpentAtoms: '250000000' });
    let treasury: Address;
    beforeAll(async () => {
      [treasury] = await findTreasuryPda({ coinMint: treasuryCoin });
    });

    it('prepares a first update that the existing verifier accepts once the authority signs it', async () => {
      const r = await post(`/v1/treasuries/${treasury}/updates/prepare`, base());
      expect(r.status).toBe(200);
      expect(r.body.body).toMatchObject({ sequence: 1, previousId: null, authority: team.address, cluster: 'devnet', issuedAt: NOW, declaredSpentAtoms: '250000000' });
      expect(r.body.message).toBe(`opening-cross/treasury-update/v1\n${r.body.id}`);
      expect(r.body.memoText).toBe(memoTextOf(treasury, 1, r.body.id));
      const signed: SignedUpdate = await signUpdate(r.body.body, team);
      expect(signed.id).toBe(r.body.id);
      expect(await verifyUpdate(signed)).toEqual({ ok: true });
    });

    it('chains the next update to the last one stored', async () => {
      updates.push({ id: 'a'.repeat(64), sequence: 4 });
      const r = await post(`/v1/treasuries/${treasury}/updates/prepare`, base());
      expect(r.body.body).toMatchObject({ sequence: 5, previousId: 'a'.repeat(64) });
      updates.length = 0;
    });

    it('refuses the wrong wallet, an empty title, a summary that is too long, a future span and a reversed span', async () => {
      const url = `/v1/treasuries/${treasury}/updates/prepare`;
      expect(await post(url, { ...base(), authority: (await kp()).address })).toMatchObject({ status: 422, body: { reason: 'NOT_THE_AUTHORITY' } });
      expect((await post(url, { ...base(), title: '   ' })).status).toBe(400);
      expect((await post(url, { ...base(), title: 'x'.repeat(121) })).status).toBe(400);
      expect((await post(url, { ...base(), summary: 'x'.repeat(4001) })).status).toBe(400);
      expect((await post(url, { ...base(), coveredTo: NOW + 10 })).status).toBe(400);
      expect((await post(url, { ...base(), coveredFrom: NOW, coveredTo: NOW - 1 })).status).toBe(400);
      expect((await post(url, { ...base(), declaredSpentAtoms: '-5' })).status).toBe(400);
      expect((await post(url, { ...base(), coveredFrom: 'yesterday' })).status).toBe(400);
      expect((await post(`/v1/treasuries/${ghost}/updates/prepare`, base())).status).toBe(404);
      expect((await post(`/v1/treasuries/not-an-address/updates/prepare`, base())).status).toBe(400);
    });

    it('leaves the declared figure out when none is given', async () => {
      const { declaredSpentAtoms: _x, ...rest } = base();
      const r = await post(`/v1/treasuries/${treasury}/updates/prepare`, rest);
      expect(r.body.body.declaredSpentAtoms).toBeNull();
      expect((await post(`/v1/treasuries/${treasury}/updates/prepare`, { ...rest, declaredSpentAtoms: '' })).body.body.declaredSpentAtoms).toBeNull();
    });

    it('builds the anchoring Memo transaction signed by the authority, carrying exactly the memo text the API checks', async () => {
      const id = 'b'.repeat(64);
      const r = await post('/v1/tx/treasury-memo', { treasury, payer: team.address, sequence: 2, id });
      expect(r.status).toBe(200);
      expect(r.body.memoText).toBe(memoTextOf(treasury, 2, id));
      const tx = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(r.body.transaction, 'base64')));
      const msg = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
      const ix = msg.instructions[0]!;
      expect(ix.programAddress).toBe(MEMO_PROGRAM);
      expect(new TextDecoder().decode(ix.data!)).toBe(memoTextOf(treasury, 2, id));
      expect(r.body.signers).toEqual([team.address]);
    });

    it('refuses to anchor for someone who is not the authority, or with a malformed id or sequence', async () => {
      const id = 'b'.repeat(64);
      const other = (await kp()).address;
      expect(await post('/v1/tx/treasury-memo', { treasury, payer: other, sequence: 1, id })).toMatchObject({ status: 422, body: { reason: 'NOT_THE_AUTHORITY' } });
      expect((await post('/v1/tx/treasury-memo', { treasury, payer: team.address, sequence: 0, id })).status).toBe(400);
      expect((await post('/v1/tx/treasury-memo', { treasury, payer: team.address, sequence: 1, id: 'ZZ' })).status).toBe(400);
      expect((await post('/v1/tx/treasury-memo', { treasury: ghost, payer: team.address, sequence: 1, id })).status).toBe(404);
    });
  });
});

describe('program ids the web app carries', () => {
  it('the token program ids in the issuer checklist equal the official packages’', () => {
    expect(SPL_TOKEN).toBe(SPL_TOKEN_PROGRAM_ADDRESS);
    expect(TOKEN_2022).toBe(TOKEN_2022_PROGRAM_ADDRESS);
  });
});
