import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { ActionError, memoryStore } from '@opening-cross/client';
import {
  BestExecution,
  BookDepth,
  CrossStatus,
  FairnessReceipt,
  OrderList,
  RevealButton,
  walletStandardSigner,
  useBestExecution,
  useCross,
  type Signer,
} from '../src/index.js';
import { ADDRESS, OWNER, Providers, cross, fakeNetwork, fakeWallet, fakeWire } from './helpers.js';

const NOW = BigInt(1_800_000_000);
const a11y = async (c: HTMLElement) => (await axe.run(c, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);

describe('CrossStatus', () => {
  it('shows the live phase, the countdown on the given clock, the headline price from the book and the seller fee', async () => {
    const { container } = render(
      <Providers net={fakeNetwork()}>
        <CrossStatus cross={cross()} now={NOW} book={{ disclosure: 'open', levels: [], indicative: { price: '1250000', matched: '10000000' }, note: 'x' }} />
      </Providers>,
    );
    expect(screen.getByTestId('state-badge').textContent).toBe('Open');
    expect(screen.getByTestId('price').textContent).toBe('1.25');
    expect(screen.getByText(/10 tokens would trade/)).toBeTruthy();
    expect(screen.getByTestId('countdown').textContent).toBe('1h 00m 00s');
    expect(screen.getByText('0.25%')).toBeTruthy();
    expect(await a11y(container)).toEqual([]);
  });

  it('shows a cleared cross’s clearing price and a no-print cross’s reason, never an invented price', () => {
    const cleared = render(
      <Providers net={fakeNetwork()}>
        <CrossStatus cross={cross({ state: 'Cleared', clearing: { price: '1300000', matched: '5000000', rationed: 'none' } })} now={NOW} />
      </Providers>,
    );
    expect(cleared.getByTestId('price').textContent).toBe('1.3');
    expect(cleared.queryByTestId('countdown')).toBeNull();
    cleared.unmount();
    const np = render(
      <Providers net={fakeNetwork()}>
        <CrossStatus cross={cross({ state: 'NoPrint', noPrintReason: 'BelowMinimumVolume' })} now={NOW} />
      </Providers>,
    );
    expect(np.getByTestId('price').textContent).toBe('No print');
    expect(np.getByText(/every order is refunded in full/)).toBeTruthy();
  });

  it('says a sealed cross’s price is hidden, not that there is none', () => {
    render(
      <Providers net={fakeNetwork()}>
        <CrossStatus cross={cross({ disclosure: 'sealed' })} now={NOW} />
      </Providers>,
    );
    expect(screen.getByTestId('price').textContent).toBe('Sealed');
  });

  it('reports the outcome of a chain check in words', () => {
    for (const [status, text] of [
      ['verified', 'every field matches'],
      ['mismatch', 'Trust the chain'],
      ['unavailable', 'Could not check against the chain'],
    ] as const) {
      const { unmount } = render(
        <Providers net={fakeNetwork()}>
          <CrossStatus cross={cross()} now={NOW} verification={{ status, differences: [], reason: null }} />
        </Providers>,
      );
      expect(screen.getByText(new RegExp(text))).toBeTruthy();
      unmount();
    }
  });
});

describe('useCross', () => {
  const setup = (net: ReturnType<typeof fakeNetwork>) => ({ wrapper: ({ children }: { children: React.ReactNode }) => <Providers net={net}>{children}</Providers> });

  it('reads the API by default and does not touch the chain', async () => {
    const net = fakeNetwork();
    net.route('GET', `/v1/crosses/${ADDRESS}`, () => ({ body: cross() }));
    const { result } = renderHook(() => useCross(ADDRESS, { stream: false, pollMs: 0 }), setup(net));
    await waitFor(() => expect(result.current.cross).not.toBeNull());
    expect(result.current.source).toBe('api');
    expect(result.current.verification.status).toBe('off');
    expect(net.rpcCalls).toEqual([]);
  });

  it('keeps showing the last good answer, marked stale, when a refresh fails', async () => {
    const net = fakeNetwork();
    let fail = false;
    net.route('GET', `/v1/crosses/${ADDRESS}`, () => (fail ? { status: 500, body: { error: 'boom' } } : { body: cross() }));
    const { result } = renderHook(() => useCross(ADDRESS, { stream: false, pollMs: 0 }), setup(net));
    await waitFor(() => expect(result.current.cross).not.toBeNull());
    fail = true;
    await result.current.refresh();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.cross).not.toBeNull();
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toBeInstanceOf(ActionError);
  });

  it('a null address loads nothing', () => {
    const net = fakeNetwork();
    const { result } = renderHook(() => useCross(null), setup(net));
    expect(result.current.status).toBe('idle');
    expect(net.requests).toEqual([]);
  });
});

describe('walletStandardSigner', () => {
  it('signs one transaction, and many in a single wallet call', async () => {
    const feature = { signTransaction: vi.fn(async (...inputs: { transaction: Uint8Array }[]) => inputs.map((i) => ({ signedTransaction: Uint8Array.from([...i.transaction, 9]) }))) };
    const sign: Signer = walletStandardSigner(feature, { address: OWNER, chains: ['solana:devnet'] }, 'solana:devnet');
    expect((await sign({ transaction: Uint8Array.from([1]) })).signedTransaction).toEqual(Uint8Array.from([1, 9]));
    const many = await sign.many!([Uint8Array.from([1]), Uint8Array.from([2])]);
    expect(many).toEqual([Uint8Array.from([1, 9]), Uint8Array.from([2, 9])]);
    expect(feature.signTransaction).toHaveBeenCalledTimes(2);
    expect(feature.signTransaction.mock.calls[1]).toHaveLength(2);
  });

  it('refuses an account that does not support the cluster, and a wallet that returns the wrong number of signatures', async () => {
    expect(() => walletStandardSigner({ signTransaction: async () => [] }, { address: OWNER, chains: ['solana:mainnet'] }, 'solana:devnet')).toThrow(/does not support solana:devnet/);
    const sign = walletStandardSigner({ signTransaction: async () => [] }, { address: OWNER }, 'solana:devnet');
    await expect(sign({ transaction: Uint8Array.from([1]) })).rejects.toThrow(/returned 0 signed transactions for 1/);
  });
});

describe('BookDepth', () => {
  it('draws bars and carries the exact numbers in a table for screen readers', async () => {
    const { container } = render(
      <BookDepth
        market={{ priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 }}
        clearing="1250000"
        book={{ disclosure: 'open', note: 'Indicative', indicative: null, levels: [{ price: '1200000', buy: '5000000', sell: '0', buyOrders: 1, sellOrders: 0 }, { price: '1250000', buy: '1000000', sell: '8000000', buyOrders: 1, sellOrders: 2 }] }}
      />,
    );
    const table = container.querySelector('table')!;
    expect(within(table).getByText('1.25')).toBeTruthy();
    expect(within(table).getByText('8')).toBeTruthy();
    expect(await a11y(container)).toEqual([]);
  });

  it('says what an empty sealed book means', () => {
    render(<BookDepth market={{ priceScale: 1n, baseDecimals: 0, quoteDecimals: 0 }} book={{ disclosure: 'sealed', levels: [], indicative: null, note: '' }} />);
    expect(screen.getByText(/Sealed: the book appears once bids are revealed/)).toBeTruthy();
  });
});

describe('FairnessReceipt', () => {
  const proof = (verified: boolean) => ({
    schema: 'opening-cross/fairness-proof/v1',
    program: 'x',
    cross: ADDRESS,
    state: 'Cleared',
    params: { minPrice: '1000000', tick: '50000', ticks: 11, priceScale: '1000000', referencePrice: null, minMatched: '0', maxImbalanceBps: null, oracleGuard: false },
    book: [],
    onchain: { printed: true, price: '1250000', matched: '10000000', rationed: null, noPrintReason: null },
    recomputed: { printed: true, price: verified ? '1250000' : '1300000', matched: '10000000', rationed: null, noPrintReason: null },
    verified,
    notes: ['Recomputed from the book as cleared.'],
  });

  it('shows both sides, the notes, the download and the command to check it yourself', async () => {
    const net = fakeNetwork();
    net.route('GET', `/v1/crosses/${ADDRESS}/proof`, () => ({ body: proof(true) }));
    const { container } = render(
      <Providers net={net}>
        <FairnessReceipt cross={ADDRESS} state="Cleared" market={{ priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 }} />
      </Providers>,
    );
    expect(await screen.findByText('Result independently verified')).toBeTruthy();
    expect(screen.getByText(`opening-cross verify ${ADDRESS}`)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download the fairness proof' }).getAttribute('href')).toBe(`http://api.test/v1/crosses/${ADDRESS}/proof`);
    expect(screen.getAllByText('1.25')).toHaveLength(2);
    expect(await a11y(container)).toEqual([]);
  });

  it('says plainly when the result did not verify', async () => {
    const net = fakeNetwork();
    net.route('GET', `/v1/crosses/${ADDRESS}/proof`, () => ({ body: proof(false) }));
    render(
      <Providers net={net}>
        <FairnessReceipt cross={ADDRESS} state="Cleared" />
      </Providers>,
    );
    expect(await screen.findByText('Result did not verify')).toBeTruthy();
    expect(screen.getByTestId('fairness-receipt').getAttribute('data-verified')).toBe('false');
  });

  it('asks for nothing while the cross is live', () => {
    const net = fakeNetwork();
    const { container } = render(
      <Providers net={net}>
        <FairnessReceipt cross={ADDRESS} state="Live" />
      </Providers>,
    );
    expect(container.textContent).toBe('');
    expect(net.requests).toEqual([]);
  });

  it('shows the API’s refusal instead of a blank card', async () => {
    const net = fakeNetwork();
    net.route('GET', `/v1/crosses/${ADDRESS}/proof`, () => ({ status: 404, body: { error: 'cross not found' } }));
    render(
      <Providers net={net}>
        <FairnessReceipt cross={ADDRESS} state="Cleared" />
      </Providers>,
    );
    expect((await screen.findByRole('alert')).textContent).toBe('cross not found');
  });
});

describe('best execution', () => {
  it('renders nothing on a deployment without the router, and the comparison when there is one', async () => {
    const without = fakeNetwork();
    const a = render(
      <Providers net={without}>
        <BestExecution cross={cross()} side="buy" quantity="10000000" />
      </Providers>,
    );
    await waitFor(() => expect(without.requests.length).toBe(1));
    expect(a.container.textContent).toBe('');
    a.unmount();

    const withRouter = fakeNetwork();
    withRouter.route('POST', '/v1/route/quote', () => ({ body: { recommendation: 'cross', comparison: { crossPrice: '1200000', dexPrice: '1250000', crossBetterByBps: 40, filledOnCross: '10000000', filledOnDex: '10000000' }, caveats: ['DEX quote is 3 s old.'] } }));
    render(
      <Providers net={withRouter}>
        <BestExecution cross={cross()} side="buy" quantity="10000000" />
      </Providers>,
    );
    expect(await screen.findByText('This cross is the better venue for this order.')).toBeTruthy();
    expect(screen.getByText('40 bps')).toBeTruthy();
    expect(screen.getByText('DEX quote is 3 s old.')).toBeTruthy();
  });

  it('drops the answer to an intent that was replaced, and asks for nothing without a quantity', async () => {
    const net = fakeNetwork();
    let release: (() => void) | null = null;
    net.route('POST', '/v1/route/quote', (body) => ({ body: { recommendation: (body as { quantity: string }).quantity === '1' ? 'cross' : 'dex' } }));
    const real = net.fetch;
    net.fetch = (async (u: string, i?: RequestInit) => {
      if (String(u).endsWith('/v1/route/quote') && JSON.parse(String(i?.body)).quantity === '1') await new Promise<void>((r) => (release = r));
      return real(u, i);
    }) as unknown as typeof fetch;
    const { result, rerender } = renderHook(({ q }: { q: string | null }) => useBestExecution(q ? { cross: ADDRESS, side: 'buy', quantity: q } : null, { debounceMs: 0 }), { initialProps: { q: '1' as string | null }, wrapper: ({ children }: { children: React.ReactNode }) => <Providers net={net}>{children}</Providers> });
    await waitFor(() => expect(release).not.toBeNull());
    rerender({ q: '2' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect((result.current as unknown as { report: { recommendation: string } }).report.recommendation).toBe('dex');
    release!();
    await new Promise((r) => setTimeout(r, 20));
    expect((result.current as unknown as { report: { recommendation: string } }).report.recommendation).toBe('dex');
    rerender({ q: null });
    expect(result.current.status).toBe('idle');
  });
});

describe('OrderList and the sealed vault', () => {
  const sealedCross = () => cross({ disclosure: 'sealed', window: { openTs: String(Number(NOW) - 600), closeTs: String(Number(NOW) - 100), revealEndTs: String(Number(NOW) + 300) } });

  function stack(open: boolean) {
    const net = fakeNetwork();
    net.route('GET', `/v1/owners/${OWNER}/orders`, () => ({ body: { orders: [] } }));
    net.route('GET', '/v1/orders', () => ({ body: { orders: [{ address: 'OrderAddr', found: true, open, cross: ADDRESS, owner: OWNER, nonce: '77', index: 0, side: 'buy', revealed: false, escrow: '36000000' }] } }));
    net.route('POST', '/v1/tx/reveal', () => ({ body: { transaction: fakeWire(5), signers: [OWNER] } }));
    return net;
  }

  it('offers Reveal during the reveal window when the vault has the bid, and sends the stored values to the builder', async () => {
    const net = stack(true);
    const store = memoryStore();
    await store.save({ cross: ADDRESS, owner: OWNER, nonce: '77', side: 'buy', price: '1200000', quantity: '30000000', salt: 'ab'.repeat(32), placedAt: 'x' });
    await store.remember(ADDRESS, OWNER, 'OrderAddr');
    const wallet = fakeWallet();
    render(
      <Providers net={net} wallet={wallet} store={store}>
        <OrderList cross={sealedCross()} now={NOW} />
      </Providers>,
    );
    const reveal = await screen.findByRole('button', { name: 'Reveal bid' });
    expect(screen.getByTestId('order').textContent).toMatch(/buy\s*30 at 1\.2/i);
    await userEvent.setup().click(reveal);
    await waitFor(() => expect(net.rpcCalls).toEqual(['sendTransaction', 'getSignatureStatuses']));
    const body = net.requests.find((r) => r.url === '/v1/tx/reveal')!.body as Record<string, string>;
    expect(body).toMatchObject({ cross: ADDRESS, owner: OWNER, nonce: '77', price: '1200000', quantity: '30000000', salt: 'ab'.repeat(32) });
  });

  it('says what to do when the vault does not have the bid, and accepts a backup file', async () => {
    const net = stack(true);
    const store = memoryStore();
    await store.remember(ADDRESS, OWNER, 'OrderAddr');
    render(
      <Providers net={net} wallet={fakeWallet()} store={store}>
        <OrderList cross={sealedCross()} now={NOW} />
      </Providers>,
    );
    expect(await screen.findByText(/does not have the details for one of your sealed bids/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reveal bid' }) as HTMLButtonElement).disabled).toBe(true);
    const backup = JSON.stringify({ schema: 'opening-bell/sealed-bids/v1', bids: [{ cross: ADDRESS, owner: OWNER, nonce: '77', side: 'buy', price: '1200000', quantity: '30000000', salt: 'cd'.repeat(32), placedAt: 'x' }] });
    await userEvent.setup().upload(screen.getByLabelText('Load reveal backup'), new File([backup], 'backup.json', { type: 'application/json' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reveal bid' }) as HTMLButtonElement).disabled).toBe(false));
    expect((await store.list(ADDRESS, OWNER))[0]!.salt).toBe('cd'.repeat(32));
  });

  it('refuses a junk backup with a sentence and keeps the vault untouched', async () => {
    const net = stack(true);
    const store = memoryStore();
    await store.remember(ADDRESS, OWNER, 'OrderAddr');
    render(
      <Providers net={net} wallet={fakeWallet()} store={store}>
        <OrderList cross={sealedCross()} now={NOW} />
      </Providers>,
    );
    await screen.findByLabelText('Load reveal backup');
    await userEvent.setup().upload(screen.getByLabelText('Load reveal backup'), new File(['{"nope": 1}'], 'x.json', { type: 'application/json' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This is not an Opening Cross sealed-bid backup.');
    expect(await store.list(ADDRESS, OWNER)).toEqual([]);
  });

  it('does not render for a visitor without a wallet', () => {
    const { container } = render(
      <Providers net={fakeNetwork()}>
        <OrderList cross={cross()} now={NOW} />
      </Providers>,
    );
    expect(container.textContent).toBe('');
  });

  it('a standalone RevealButton is disabled and explains itself when the vault is empty', async () => {
    render(
      <Providers net={fakeNetwork()} wallet={fakeWallet()} store={memoryStore()}>
        <RevealButton cross={sealedCross()} owner={OWNER} nonce="1" />
      </Providers>,
    );
    expect((screen.getByRole('button', { name: 'Reveal bid' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/does not have the details of this bid/)).toBeTruthy();
  });
});
