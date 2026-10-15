// A local stand-in for the Cleanverse sandbox, used only by tests. It implements the documented contract: the api-id
// header, AES-encrypted bodies for the endpoints the reference lists, the envelope and its codes, A-Pass state and the
// validator reads. Where the reference is silent (the message for an unknown wallet) it uses an assumed text, which the
// real-sandbox smoke run must confirm; see docs/evidence/G-cleanverse-client.md.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decryptText, keyFromApiKey } from '../src/aes.js';

export type StubPass = {
  cvRecordId: string;
  customerId: string;
  chain: string;
  walletAddress: string;
  status: 1 | 2;
  tier: string;
  subTier: number;
  group: string;
  subGroup: string;
  countries: string[];
  expirationTime: number;
  currentKycHash: string;
  registeredAt: string;
};

export const STUB_API_ID = 'stub-api-id-0001';
/** 32 random-looking bytes, Base64; a test fixture, not a credential. */
export const STUB_API_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const ENCRYPTED = new Set(['/generate_apass', '/update_status']);

export class StubCleanverse {
  readonly passes = new Map<string, StubPass>();
  readonly requests: { path: string; plaintext: unknown }[] = [];
  /** The next N requests are answered with this HTTP status before any processing. */
  failNext: { count: number; status: number } | null = null;
  /** Delay every response by this many ms (timeout tests). */
  delayMs = 0;
  /** Replace the next response body verbatim (hostile-provider tests). */
  overrideNext: { status: number; body: string } | null = null;
  /** Wallets whose A-Pass exists but is not in this institution's registration list (query_apass_list). */
  unlisted = new Set<string>();
  pausedPools = new Set<string>();
  registeredPools = new Map<string, unknown[]>();
  poolValid = new Map<string, boolean>();
  private server: Server | null = null;
  private seq = 1000;
  private readonly key = keyFromApiKey(STUB_API_KEY);

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body, type }) => {
        const send = () => {
          res.writeHead(status, { 'content-type': type ?? 'application/json' });
          res.end(body);
        };
        if (this.delayMs > 0) setTimeout(send, this.delayMs);
        else send();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/cooperate`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }

  put(p: Partial<StubPass> & { chain: string; walletAddress: string }): StubPass {
    const id = String(++this.seq);
    const rec: StubPass = {
      cvRecordId: id,
      customerId: `CUST${id.padStart(12, '0')}`,
      status: 1,
      tier: '1',
      subTier: 0,
      group: '',
      subGroup: '',
      countries: ['IN'],
      expirationTime: Math.floor(Date.now() / 1000) + 365 * 86400,
      currentKycHash: `${id}`.padStart(64, 'a'),
      registeredAt: '2026-10-12T10:00:00',
      ...p,
    };
    this.passes.set(`${rec.chain}:${rec.walletAddress}`, rec);
    return rec;
  }

  private ok(data: unknown, message = 'success') {
    return { status: 200, body: JSON.stringify({ code: '0000', message, data }) };
  }
  private fail(code: string, message: string) {
    return { status: 200, body: JSON.stringify({ code, message, data: '' }) };
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: string; type?: string }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '').replace(/^\/api\/cooperate/, '');
    if (this.overrideNext) {
      const o = this.overrideNext;
      this.overrideNext = null;
      return o;
    }
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      return { status: this.failNext.status, body: 'upstream failure', type: 'text/plain' };
    }
    const apiId = req.headers['api-id'];
    if (apiId === undefined) return { status: 400, body: JSON.stringify({ timestamp: 'now', status: 400, error: 'Bad Request', path: req.url }) };
    if (apiId !== STUB_API_ID) return { status: 403, body: 'Forbidden.Please check your api-id Or contact Cleanverse.', type: 'text/plain;charset=UTF-8' };

    let body: Record<string, unknown>;
    try {
      const outer = JSON.parse(raw) as Record<string, unknown>;
      if (ENCRYPTED.has(path)) {
        if (typeof outer.data !== 'string') return { status: 400, body: 'Invalid request parameters or encryption format', type: 'text/plain' };
        try {
          body = JSON.parse(decryptText(outer.data, this.key)) as Record<string, unknown>;
        } catch {
          return { status: 403, body: 'Data decryption failure', type: 'text/plain' };
        }
      } else body = outer;
    } catch {
      return { status: 400, body: 'Invalid JSON', type: 'text/plain' };
    }
    this.requests.push({ path, plaintext: body });
    return this.route(path, body);
  }

  private route(path: string, b: Record<string, unknown>): { status: number; body: string } {
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    switch (path) {
      case '/generate_apass': {
        const w = b.wallet as { address?: string; chain?: string } | undefined;
        const cid = s('customerId');
        if (!w?.address || !w.chain) return this.fail('0002', '[400]wallet is required');
        if (!/^[A-Za-z0-9]{12,}$/.test(cid)) return this.fail('0002', '[400]customerId format is incorrect');
        if (typeof b.expirationTime !== 'number') return this.fail('0002', '[400]expirationTime is required');
        const k = `${w.chain.toLowerCase()}:${w.address}`;
        const had = this.passes.get(k);
        if (had && b.override !== true) return { status: 200, body: JSON.stringify({ code: '1000', message: 'If there is an A-Pass group, whether it is updated or not, the update will affect the circulation of tokens under the previous group', data: '{}' }) };
        const idList = (b.identityDataList as { issuingCountryISO2?: string }[] | undefined) ?? [];
        const countries = [...new Set(idList.map((d) => (d.issuingCountryISO2 ?? '').toUpperCase()).filter(Boolean))];
        const rec = this.put({ chain: w.chain.toLowerCase(), walletAddress: w.address, customerId: cid, countries, expirationTime: b.expirationTime, tier: '3', ...(had ? { cvRecordId: had.cvRecordId } : {}) });
        return this.ok({ customerId: cid, cvRecordId: rec.cvRecordId, tier: rec.tier, wallet: { operate: had ? 'update' : 'create', address: w.address, chain: rec.chain, txHash: `tx${rec.cvRecordId}`, apassAddress: `PDA${rec.cvRecordId}` } });
      }
      case '/update_status': {
        const w = b.wallet as { address?: string; chain?: string } | undefined;
        const rec = w?.address && w.chain ? this.passes.get(`${w.chain.toLowerCase()}:${w.address}`) : undefined;
        if (!rec) return this.fail('0002', 'Failure. Please contact Cleanverse Support.');
        if (b.status !== '1' && b.status !== '2') return this.fail('0001', 'The parameter is incorrect. Please check the parameter.');
        rec.status = b.status === '1' ? 1 : 2;
        return this.ok({ txHash: `0xstatus${rec.cvRecordId}` });
      }
      case '/query_apass': {
        const rec = this.passes.get(`${s('chain').toLowerCase()}:${s('address')}`);
        if (!s('chain') || !s('address')) return this.fail('0001', 'The parameter is incorrect. Please check the parameter.');
        if (!rec) return this.fail('0002', '[404]A-Pass not found for this address');
        return this.ok({ cvRecordId: rec.cvRecordId, subTier: rec.subTier, status: rec.status, tier: rec.tier, expirationTime: rec.expirationTime, subGroup: rec.subGroup, currentKycHash: rec.currentKycHash, group: rec.group, countries: rec.countries });
      }
      case '/query_apass_list': {
        const all = [...this.passes.values()].filter((p) => !this.unlisted.has(`${p.chain}:${p.walletAddress}`) && (!b.chain || p.chain === b.chain) && (!b.walletAddress || p.walletAddress === b.walletAddress) && (!b.customerId || p.customerId === b.customerId) && (!b.status || p.status === b.status));
        const pageSize = typeof b.pageSize === 'number' ? Math.min(b.pageSize, 100) : 20;
        const page = typeof b.page === 'number' ? b.page : 1;
        return this.ok({ total: all.length, page, pageSize, items: all.slice((page - 1) * pageSize, page * pageSize).map((p) => ({ ...p, apassAddress: `PDA${p.cvRecordId}`, txHash: `tx${p.cvRecordId}` })) });
      }
      case '/verify_apass': {
        const rec = this.passes.get(`${s('chain').toLowerCase()}:${s('address')}`);
        const now = Math.floor(Date.now() / 1000);
        const code = !rec ? 2 : rec.status !== 1 || rec.expirationTime <= now ? 3 : 4;
        return this.ok({ chain: s('chain'), atoken: s('atoken'), address: s('address'), code, message: code === 4 ? 'apass verify success' : 'not allowed', magickLink: 'https://register.example.invalid/apass/x' }, 'ok');
      }
      case '/query_deposit_atoken_list':
        return this.ok({ chain: s('chain'), tokens: [{ origin_token: { address: 'USDCmint', name: 'usdc', symbol: 'usdc', decimals: 6, icon: '' }, atoken: { address: 'AUSDCmint', name: 'ausdc', symbol: 'ausdc', decimals: 6, icon: '' }, accesscore_address: 'core', apass_address: 'apass' }] }, 'ok');
      case '/faucet':
        return this.ok({ chain: s('chain'), symbol: s('symbol'), deposit_address: s('depositAddress'), amount: s('amount'), tx_hash: 'faucettx' }, 'ok');
      case '/validator/is_register':
        return this.ok({ chain: s('chain'), contract_address: s('contract_address').toLowerCase(), registered: this.registeredPools.has(s('contract_address')) });
      case '/validator/rules':
        return this.ok({ chain: s('chain'), contract_address: s('contract_address').toLowerCase(), rules: this.registeredPools.get(s('contract_address')) ?? [] });
      case '/validator/is_paused':
        return this.ok({ chain: s('chain'), contract_address: s('contract_address').toLowerCase(), paused: this.pausedPools.has(s('contract_address')) });
      case '/validator/verify':
        if (this.pausedPools.has(s('contract_address'))) return this.fail('12027', '[12027]validator on-chain read failed: pool is paused');
        return this.ok({ chain: s('chain'), contract_address: s('contract_address').toLowerCase(), user_address: s('user_address').toLowerCase(), valid: this.poolValid.get(`${s('contract_address')}:${s('user_address')}`) ?? false });
      default:
        return { status: 404, body: JSON.stringify({ status: 404, error: 'Not Found', path }) };
    }
  }
}
