// Getting the token a cross is paid in (I4, I5; ADR-0403). Nothing here moves money: it builds the link to a payment provider's own
// widget from the provider's documented query parameters, and the hand-off link to a swap page. Both exist only where they can work:
// a provider needs an account and a key (NEXT_PUBLIC_ONRAMP_URL and NEXT_PUBLIC_ONRAMP_KEY), and neither the provider nor Jupiter has
// anything to sell or swap on devnet.
export const ONRAMP_URL = process.env.NEXT_PUBLIC_ONRAMP_URL ?? null;
export const ONRAMP_KEY = process.env.NEXT_PUBLIC_ONRAMP_KEY ?? null;
/** The one token the provider sells here, by its mint and by the provider's code for it (for example USDC): a cross paid in anything else gets no card button. */
export const ONRAMP_MINT = process.env.NEXT_PUBLIC_ONRAMP_MINT ?? null;
export const ONRAMP_CODE = process.env.NEXT_PUBLIC_ONRAMP_CODE ?? null;

export type Onramp = { base: string; apiKey: string; address: string; cryptoCurrencyCode: string; fiatCurrency?: string; defaultFiatAmount?: number; referrerDomain: string };

/**
 * The provider's widget link with the destination wallet and the token filled in and not editable. Parameters are the provider's
 * documented ones (apiKey, network, cryptoCurrencyCode, walletAddress, disableWalletAddressForm, fiatCurrency, defaultFiatAmount,
 * referrerDomain). Returns null for anything that is not an https address.
 */
export function onrampLink(o: Onramp): string | null {
  let u: URL;
  try {
    u = new URL(o.base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  u.searchParams.set('apiKey', o.apiKey);
  u.searchParams.set('network', 'solana');
  u.searchParams.set('cryptoCurrencyCode', o.cryptoCurrencyCode);
  u.searchParams.set('walletAddress', o.address);
  u.searchParams.set('disableWalletAddressForm', 'true');
  u.searchParams.set('referrerDomain', o.referrerDomain);
  if (o.fiatCurrency) u.searchParams.set('fiatCurrency', o.fiatCurrency);
  if (o.defaultFiatAmount !== undefined && o.fiatCurrency) u.searchParams.set('defaultFiatAmount', String(o.defaultFiatAmount));
  return u.toString();
}

/** The fiat currency to suggest from a browser locale (`en-IN` is INR); null where the locale names no country this knows. */
export function fiatFromLocale(locale: string): string | null {
  const region = /-([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase();
  const map: Record<string, string> = { IN: 'INR', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BR: 'BRL', AU: 'AUD', CA: 'CAD', JP: 'JPY', SG: 'SGD', AE: 'AED', NG: 'NGN', MX: 'MXN' };
  return region ? (map[region] ?? null) : null;
}

/** Jupiter's own swap page for an input and an output mint: a hand-off, where the person signs the swap there. Mainnet only. */
export function swapHandOff(inputMint: string | null, outputMint: string): string {
  return `https://jup.ag/swap/${inputMint ?? 'SOL'}-${outputMint}`;
}

/** True for the Wallet Standard mainnet chain id; every other chain this app runs on is a test network. */
export const onMainnet = (chain: string): boolean => chain === 'solana:mainnet';
