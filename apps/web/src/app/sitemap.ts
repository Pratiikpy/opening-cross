import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

// The operations console (/ops) is not listed: it is for a few signed-in people, and robots.txt asks crawlers to stay out of it.
// Cross pages are not listed: they are many, short-lived and read from the chain. The sitemap needs absolute URLs, so
// without a configured site address (NEXT_PUBLIC_SITE_URL) it is empty rather than wrong.
const ROUTES = ['/', '/crosses', '/issue', '/premium', '/accuracy', '/developers', '/status', '/calendar', '/live', '/replay', '/gates', '/pools', '/treasury', '/export', '/issuer', '/issuer/simulator', '/issuer/demand', '/issuer/apply', '/issuer/growth', '/issuer/accelerators', '/issuer/settle', '/issuer/series', '/issuer/halts', '/issuer/treasury', '/issuer/disclosures', '/series', '/arbiter', '/dashboard', '/mandates', '/agents', '/conviction', '/baskets', '/baskets/new', '/listing', '/bounties', '/bounties/new', '/backing', '/issuer/graduation', '/issuer/listing', '/issuer/backing', '/portfolio', '/markets', '/alerts', '/rights', '/practice', '/support'];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return base ? ROUTES.map((path) => ({ url: `${base}${path === '/' ? '' : path}` })) : [];
}
