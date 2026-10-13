import { loadFigures } from '../load-figures';

export const dynamic = 'force-dynamic';

/** The public figures as JSON: the rows, and the unmodified answers of the endpoints they were computed from. */
export async function GET() {
  const f = await loadFigures();
  if (f.rows.length === 0) return Response.json({ error: 'The Opening Cross API answered none of the figure sources.', missing: f.missing }, { status: 503 });
  return new Response(
    JSON.stringify({ schema: 'opening-bell/public-figures/v1', network: f.network, generatedAt: f.generatedAt, missingSources: f.missing, rows: f.rows, sources: { '/v1/stats': f.inputs.stats, '/v1/metrics/execution': f.inputs.execution, '/v1/metrics/fairness': f.inputs.fairness, '/v1/metrics/external-flow': f.inputs.flow } }, null, 2),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="opening-bell-public-figures.json"', 'cache-control': 'public, max-age=15' } },
  );
}
