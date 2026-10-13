import { describe, expect, it } from 'vitest';
import { fiatFromLocale, onMainnet, onrampLink, swapHandOff } from '../src/lib/holder-pay';

describe('onramp link', () => {
  const base = { base: 'https://provider.example/widget', apiKey: 'key-1', address: 'Wallet1111111111111111111111111111111111111', cryptoCurrencyCode: 'USDC', referrerDomain: 'app.example' };
  it('fills the destination in and locks it, using only documented parameters', () => {
    const u = new URL(onrampLink({ ...base, fiatCurrency: 'INR', defaultFiatAmount: 5000 })!);
    expect(Object.fromEntries(u.searchParams)).toEqual({ apiKey: 'key-1', network: 'solana', cryptoCurrencyCode: 'USDC', walletAddress: base.address, disableWalletAddressForm: 'true', referrerDomain: 'app.example', fiatCurrency: 'INR', defaultFiatAmount: '5000' });
  });
  it('leaves the amount out without a currency, and refuses anything that is not https', () => {
    expect(new URL(onrampLink({ ...base, defaultFiatAmount: 5000 })!).searchParams.has('defaultFiatAmount')).toBe(false);
    expect(onrampLink({ ...base, base: 'http://provider.example' })).toBeNull();
    expect(onrampLink({ ...base, base: 'javascript:alert(1)' })).toBeNull();
    expect(onrampLink({ ...base, base: 'not a url' })).toBeNull();
  });
  it('encodes a hostile address rather than letting it add parameters', () => {
    const u = new URL(onrampLink({ ...base, address: 'x&apiKey=evil' })!);
    expect(u.searchParams.get('apiKey')).toBe('key-1');
    expect(u.searchParams.get('walletAddress')).toBe('x&apiKey=evil');
  });
});

describe('locale and swap hand-off', () => {
  it('suggests a currency from a locale region', () => {
    expect(fiatFromLocale('en-IN')).toBe('INR');
    expect(fiatFromLocale('de-DE')).toBe('EUR');
    expect(fiatFromLocale('en')).toBeNull();
    expect(fiatFromLocale('xx-ZZ')).toBeNull();
  });
  it('hands off to the swap page and knows the mainnet chain id', () => {
    expect(swapHandOff(null, 'OutMint')).toBe('https://jup.ag/swap/SOL-OutMint');
    expect(swapHandOff('InMint', 'OutMint')).toBe('https://jup.ag/swap/InMint-OutMint');
    expect(onMainnet('solana:mainnet')).toBe(true);
    expect(onMainnet('solana:devnet')).toBe(false);
  });
});
