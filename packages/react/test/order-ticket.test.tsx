import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '@opening-cross/client';
import { OrderTicket } from '../src/index.js';
import { ADDRESS, OWNER, Providers, cross, fakeNetwork, fakeWallet, fakeWire } from './helpers.js';

const NOW = BigInt(1_800_000_000);

async function a11y(container: HTMLElement) {
  // jsdom has no layout, so the colour contrast rule cannot run here; the browser test in examples/react-app covers it.
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

const type = async (label: RegExp, text: string) => {
  const user = userEvent.setup();
  const input = screen.getByLabelText(label);
  await user.clear(input);
  await user.type(input, text);
};

describe('OrderTicket', () => {
  it('asks for a wallet before anything else, with your own connect slot', () => {
    const net = fakeNetwork();
    render(
      <Providers net={net}>
        <OrderTicket cross={cross()} now={NOW} connect={<button type="button">Connect wallet</button>} />
      </Providers>,
    );
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(screen.queryByLabelText(/Most you would pay/)).toBeNull();
  });

  it('checks the price against the grid as you type and says what to enter', async () => {
    render(
      <Providers net={fakeNetwork()} wallet={fakeWallet()}>
        <OrderTicket cross={cross()} now={NOW} />
      </Providers>,
    );
    const price = screen.getByLabelText(/Most you would pay/);
    await type(/Most you would pay/, '1.23');
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(price.getAttribute('aria-describedby')!)!.textContent).toBe('Prices move in steps of 0.05. Try 1.2 or 1.25.');
    await type(/Most you would pay/, '9');
    expect(document.getElementById(price.getAttribute('aria-describedby')!)!.textContent).toContain('The price must be between 1 and 1.5');
    await type(/Tokens/, '0');
    expect(screen.getByLabelText('Tokens').getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByTestId('place-order') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a buyer what leaves the wallet, the most they can pay, the fees, the failure case and the way back, before signing', async () => {
    render(
      <Providers net={fakeNetwork()} wallet={fakeWallet()}>
        <OrderTicket cross={cross()} now={NOW} />
      </Providers>,
    );
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    const preview = screen.getByTestId('preview');
    const text = (label: string) => within(preview).getByText(label).nextElementSibling!.textContent;
    expect(text('Held in escrow')).toContain('12.5 of the quote token');
    expect(text('Most you can pay')).toContain('12.5.');
    expect(text('Most you can pay')).toContain('never above your limit of 1.25');
    expect(text('Fees')).toContain('None for buyers');
    expect(text('If the cross does not print')).toContain('refunded in full with no fee');
    expect(text('Getting your money back')).toContain('cancel until the call closes');
    expect((screen.getByTestId('place-order') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a seller the least they receive net of the fee, and rounds the way the program does', async () => {
    render(
      <Providers net={fakeNetwork()} wallet={fakeWallet()}>
        <OrderTicket cross={cross()} now={NOW} />
      </Providers>,
    );
    await userEvent.setup().click(screen.getByLabelText('Sell'));
    await type(/Least you would take/, '1.25');
    await type(/Tokens/, '10');
    const preview = screen.getByTestId('preview');
    const text = (label: string) => within(preview).getByText(label).nextElementSibling!.textContent;
    expect(text('Held in escrow')).toContain('10 tokens leave your wallet');
    // 10 tokens at 1.25 = 12.5; the 0.25% fee takes 0.03125, rounded down to atoms by the program: 12.5 - 0.03125 = 12.46875.
    expect(text('Least you receive')).toContain('At least 12.46875 if all of it fills at your limit of 1.25 (12.5 less the fee)');
    expect(text('Fees')).toContain('0.25% of your proceeds');
  });

  it('is buy-only when the issuer supplies the tokens', () => {
    render(
      <Providers net={fakeNetwork()} wallet={fakeWallet()}>
        <OrderTicket cross={cross({ supplyMode: 'mint' })} now={NOW} />
      </Providers>,
    );
    expect(screen.queryByRole('group', { name: 'Side' })).toBeNull();
    expect(screen.getByLabelText(/Most you would pay/)).toBeTruthy();
    expect(screen.getByText(/takes buy orders only/)).toBeTruthy();
  });

  it('explains why it will not take an order when the cross is not open, and stays disabled', async () => {
    for (const [c, reason] of [
      [cross({ window: { openTs: String(Number(NOW) + 100), closeTs: String(Number(NOW) + 200), revealEndTs: String(Number(NOW) + 200) } }), 'has not opened yet'],
      [cross({ window: { openTs: String(Number(NOW) - 200), closeTs: String(Number(NOW) - 100), revealEndTs: String(Number(NOW) - 100) } }), 'has closed'],
      [cross({ state: 'Cleared', clearing: { price: '1250000', matched: '1', rationed: 'none' } }), 'already cleared'],
      [cross({ state: 'NoPrint' }), 'ended without printing'],
    ] as const) {
      const { unmount } = render(
        <Providers net={fakeNetwork()} wallet={fakeWallet()}>
          <OrderTicket cross={c} now={NOW} />
        </Providers>,
      );
      await type(/Most you would pay/, '1.25');
      await type(/Tokens/, '1');
      expect(screen.getByText(new RegExp(reason))).toBeTruthy();
      expect((screen.getByTestId('place-order') as HTMLButtonElement).disabled).toBe(true);
      unmount();
    }
  });

  it('places an open order through the API, the wallet and the cluster, and reports it', async () => {
    const net = fakeNetwork();
    net.route('POST', '/v1/tx/place-order', (body) => ({ body: { transaction: fakeWire(7), signers: [OWNER], order: 'OrderAddr1111111111111111111111111111111111', echo: body } }));
    const wallet = fakeWallet();
    const onPlaced = vi.fn();
    const store = memoryStore();
    render(
      <Providers net={net} wallet={wallet} store={store}>
        <OrderTicket cross={cross()} now={NOW} onPlaced={onPlaced} />
      </Providers>,
    );
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    await userEvent.setup().click(screen.getByTestId('place-order'));
    await waitFor(() => expect(screen.getByTestId('placed')).toBeTruthy());

    const post = net.requests.find((r) => r.url === '/v1/tx/place-order')!;
    expect(post.body).toMatchObject({ cross: ADDRESS, owner: OWNER, side: 'buy', price: '1250000', quantity: '10000000' });
    expect(String((post.body as { nonce: string }).nonce)).toMatch(/^\d{1,15}$/);
    expect(wallet.sign.mock.calls).toHaveLength(1);
    expect(net.rpcCalls).toEqual(['sendTransaction', 'getSignatureStatuses']);
    expect(onPlaced).toHaveBeenCalledWith({ order: 'OrderAddr1111111111111111111111111111111111', nonce: expect.stringMatching(/^\d+$/), signatures: [expect.any(String)] });
    expect(await store.remembered(ADDRESS, OWNER)).toEqual(['OrderAddr1111111111111111111111111111111111']);
    expect((screen.getByLabelText(/Most you would pay/) as HTMLInputElement).value).toBe('');
  });

  it('keeps a sealed bid’s salt before the order is built, never sends it in the clear, and offers the backup', async () => {
    const net = fakeNetwork();
    const store = memoryStore();
    let vaultAtBuild: unknown[] = [];
    net.route('POST', '/v1/tx/place-order', () => {
      return { body: { transaction: fakeWire(9), signers: [OWNER], order: 'SealedOrder1111111111111111111111111111111111' } };
    });
    const realFetch = net.fetch;
    const wrapped = (async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/v1/tx/place-order')) vaultAtBuild = await store.list(ADDRESS, OWNER);
      return realFetch(input, init);
    }) as unknown as typeof fetch;
    net.fetch = wrapped;
    render(
      <Providers net={net} wallet={fakeWallet()} store={store}>
        <OrderTicket cross={cross({ disclosure: 'sealed' })} now={NOW} />
      </Providers>,
    );
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    expect(screen.getByRole('button', { name: 'Place sealed order' })).toBeTruthy();
    expect(within(screen.getByTestId('preview')).getByText('Sealed')).toBeTruthy();
    await userEvent.setup().click(screen.getByTestId('place-order'));
    await waitFor(() => expect(screen.getByTestId('placed')).toBeTruthy());
    expect(vaultAtBuild).toHaveLength(1);
    const [bid] = await store.list(ADDRESS, OWNER);
    expect(bid).toMatchObject({ cross: ADDRESS, owner: OWNER, side: 'buy', price: '1250000', quantity: '10000000' });
    expect(bid!.salt).toMatch(/^[0-9a-f]{64}$/);
    // The API gets the salt too (it needs it for the commitment) but the request carries nothing that reveals it elsewhere.
    expect(screen.getByRole('button', { name: 'Download your reveal backup' })).toBeTruthy();
  });

  it('stops with the refusal in words when the API refuses, and nothing is signed', async () => {
    const net = fakeNetwork();
    net.route('POST', '/v1/tx/place-order', () => ({ status: 409, body: { error: 'cross is not accepting orders' } }));
    const wallet = fakeWallet();
    render(
      <Providers net={net} wallet={wallet}>
        <OrderTicket cross={cross()} now={NOW} />
      </Providers>,
    );
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    await userEvent.setup().click(screen.getByTestId('place-order'));
    expect((await screen.findByRole('alert')).textContent).toBe('cross is not accepting orders');
    expect(wallet.sign.mock.calls).toHaveLength(0);
    expect(net.rpcCalls).toEqual([]);
    expect(screen.queryByTestId('placed')).toBeNull();
  });

  it('says nothing was sent when the user declines in the wallet', async () => {
    const net = fakeNetwork();
    net.route('POST', '/v1/tx/place-order', () => ({ body: { transaction: fakeWire(3), signers: [OWNER], order: 'O' } }));
    const wallet = fakeWallet({ sign: Object.assign(async () => { throw new Error('User rejected the request.'); }, {}) });
    render(
      <Providers net={net} wallet={wallet}>
        <OrderTicket cross={cross()} now={NOW} />
      </Providers>,
    );
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    await userEvent.setup().click(screen.getByTestId('place-order'));
    expect((await screen.findByRole('alert')).textContent).toBe('You declined in your wallet. Nothing was sent.');
    expect(net.rpcCalls).toEqual([]);
  });

  it('explains a cluster refusal for a short wallet instead of showing a program error code', async () => {
    const net = fakeNetwork();
    net.route('POST', '/v1/tx/place-order', () => ({ body: { transaction: fakeWire(4), signers: [OWNER], order: 'O' } }));
    net.rpc('sendTransaction', () => ({ __error: { code: -32002, message: 'Transaction simulation failed', data: { logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 5000, need 2039280'] } } }));
    render(
      <Providers net={net} wallet={fakeWallet()}>
        <OrderTicket cross={cross()} now={NOW} />
      </Providers>,
    );
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    await userEvent.setup().click(screen.getByTestId('place-order'));
    const alert = (await screen.findByRole('alert')).textContent!;
    expect(alert).toContain('does not hold enough SOL');
    expect(alert).toContain('it has 0.0001 SOL and the step needs 0.0021 SOL');
    expect(alert).not.toContain('custom program error');
  });

  it('has no accessibility violations in its main states', async () => {
    const net = fakeNetwork();
    const { container } = render(
      <Providers net={net} wallet={fakeWallet()}>
        <OrderTicket cross={cross({ disclosure: 'sealed' })} now={NOW} />
      </Providers>,
    );
    expect(await a11y(container)).toEqual([]);
    await type(/Most you would pay/, '1.23');
    await type(/Tokens/, '0');
    expect(await a11y(container)).toEqual([]);
    await type(/Most you would pay/, '1.25');
    await type(/Tokens/, '10');
    expect(await a11y(container)).toEqual([]);
  });
});
