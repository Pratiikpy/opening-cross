// Who is behind a holder address. Every label carries the fact that justifies it, and the table of protocol authorities is the
// set of constants the protocols' own IDLs publish, checked against those IDLs by the tests; nothing is typed from memory.
import type { Label } from './types.js';

/** Program-derived authorities that hold pool reserves, as published in each protocol's IDL (`pool_authority`, `authority`). */
export const PROTOCOL_AUTHORITIES: Readonly<Record<string, { name: string; idl: string }>> = {
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: { name: 'Meteora Dynamic Bonding Curve pool authority', idl: 'idls/dynamic_bonding_curve.json' },
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: { name: 'Meteora DAMM v2 pool authority', idl: 'idls/cp_amm.json' },
  GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ: { name: 'Raydium CPMM pool authority', idl: 'idls/raydium_cp_swap.json' },
};

/** Programs whose accounts hold other people's tokens. A token account owned by an account these programs own is protocol-held. */
export const PROTOCOL_PROGRAMS: Readonly<Record<string, string>> = {
  F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ: 'Opening Cross core',
  '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ': 'Opening Cross settle',
  HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd: 'Opening Cross treasury',
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'Meteora Dynamic Bonding Curve',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: 'Meteora Met Lock',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
};

export const BURN_ADDRESSES: Readonly<Record<string, string>> = {
  '1nc1nerator11111111111111111111111111111111': 'Solana incinerator',
  '11111111111111111111111111111111': 'System program (nothing can sign for it)',
};

/** What the caller already knows about the token, from the mint and the cross. Each entry is an address and the fact that ties it to the issuer. */
export interface Declared {
  /** address -> the fact, e.g. { [mintAuthority]: 'mint authority of the token' }. */
  issuer?: Readonly<Record<string, string>>;
  /** address -> the fact, e.g. 'listed as team by the issuer in <document id>'. */
  team?: Readonly<Record<string, string>>;
}

export interface OwnerFacts {
  address: string;
  /** The program that owns the owner's own account, if that account exists; null if the address has no account (a plain wallet with no SOL, or a PDA). */
  accountOwner: string | null;
  executable?: boolean;
}

const SYSTEM = '11111111111111111111111111111111';

/** Labels one holder's owner. Order matters: a burn address is a burn even if somebody declared it, and a declared issuer wins over "wallet". */
export function labelOwner(o: OwnerFacts, declared: Declared = {}): Label {
  const burn = BURN_ADDRESSES[o.address];
  if (burn) return { kind: 'burn', name: burn, basis: 'the address is a well-known burn address' };
  const issuer = declared.issuer?.[o.address];
  if (issuer) return { kind: 'issuer', name: 'Issuer', basis: issuer };
  const team = declared.team?.[o.address];
  if (team) return { kind: 'team', name: 'Team', basis: team };
  const auth = PROTOCOL_AUTHORITIES[o.address];
  if (auth) return { kind: 'protocol', name: auth.name, basis: `the address is the authority constant in ${auth.idl}` };
  const program = o.accountOwner ? PROTOCOL_PROGRAMS[o.accountOwner] : undefined;
  if (program) return { kind: 'protocol', name: `Held by a ${program} account`, basis: `the owner's account is owned by the ${program} program (${o.accountOwner})` };
  if (o.accountOwner && o.accountOwner !== SYSTEM) return { kind: 'program-account', name: 'Held by a program account', basis: `the owner's account is owned by program ${o.accountOwner}, which is not one we can name` };
  return { kind: 'wallet', name: 'Wallet', basis: 'no program owns the holder; treated as an ordinary wallet' };
}
