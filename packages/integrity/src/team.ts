// The issuer's list of its own wallets. Without it nothing on chain says which large holder is the team; with it, F3 labels those
// holders and F8 flags their bids. The list is the issuer's word, signed, and a label made from it says so.
import { type Signed, verifyDocument } from '@opening-cross/attest';

export const TEAM_SCHEMA = 'opening-cross/team-declaration/v1';
export interface TeamBody {
  readonly [k: string]: string | number | readonly string[] | undefined;
  readonly schema: typeof TEAM_SCHEMA;
  readonly mint: string;
  readonly wallets: readonly string[];
  readonly asOf: number;
}
export type TeamDeclaration = Signed<TeamBody>;

/** The wallets of a valid declaration, each with the sentence that justifies calling it team; empty if the document does not verify. */
export async function teamWallets(doc: TeamDeclaration | null, mint: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!doc || doc.body.mint !== mint || !Array.isArray(doc.body.wallets)) return out;
  if (!(await verifyDocument(doc as never)).ok) return out;
  for (const w of doc.body.wallets) out.set(w, `listed as team by ${doc.signer} in declaration ${doc.id.slice(0, 12)}…`);
  return out;
}
