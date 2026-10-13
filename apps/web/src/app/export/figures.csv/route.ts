import { figuresCsv } from '../figures';
import { loadFigures } from '../load-figures';

export const dynamic = 'force-dynamic';

/** The public figures as CSV, one row per figure with its sample size and method. */
export async function GET() {
  const f = await loadFigures();
  if (f.rows.length === 0) return Response.json({ error: 'The Opening Cross API answered none of the figure sources.', missing: f.missing }, { status: 503 });
  return new Response(figuresCsv(f.rows, f.network, f.generatedAt), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="opening-bell-public-figures.csv"',
      'cache-control': 'public, max-age=15',
      ...(f.missing.length ? { 'x-missing-sources': f.missing.join(',') } : {}),
    },
  });
}
