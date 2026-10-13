// Encodes token mint accounts in memory for tests: a classic SPL mint, or a Token-2022 mint with extensions.
import { type Address, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token-2022';

const ISSUER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address;
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

type Ext = Record<string, unknown>;
export function mintAccount(extensions: Ext[] | null, o: { freeze?: boolean; mintAuth?: boolean; owner?: Address; decimals?: number } = {}) {
  const data = getMintEncoder().encode({
    mintAuthority: o.mintAuth ? some(ISSUER) : none(),
    supply: 1_000n,
    decimals: o.decimals ?? 6,
    isInitialized: true,
    freezeAuthority: o.freeze ? some(ISSUER) : none(),
    extensions: extensions ? some(extensions) : none(),
  } as never);
  // The classic program has no extension area; a plain mint is 82 bytes there.
  return { data: new Uint8Array(extensions ? data : data.slice(0, 82)), owner: o.owner ?? (extensions ? TOKEN_2022_PROGRAM_ADDRESS : SPL) };
}

