import { isAddress } from '@/lib/receipt-routes';
import { loadAttestation } from '../../_attestation/load';

export const dynamic = 'force-dynamic';

/**
 * The signed attestation of a cross's receipt as JSON, with every check repeated on this server: the document is the API's, the verdicts are this page's. A cross with no attestation yet answers
 * 404, so a script can tell "not yet" from "failed"; a failed check is still a 200 with the verdict in `checks`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isAddress(address)) return Response.json({ error: 'not a Solana address' }, { status: 404 });
  const loaded = await loadAttestation(address);
  if (loaded.state === 'unavailable') return Response.json({ error: loaded.reason }, { status: 503 });
  if (loaded.state === 'none') return Response.json({ error: loaded.note }, { status: 404 });
  return Response.json({ ...loaded.view, checks: loaded.checks, summary: loaded.summary }, { headers: { 'cache-control': 'public, max-age=30' } });
}
