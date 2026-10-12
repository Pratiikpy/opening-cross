// The public address of this deployment, for absolute URLs in metadata (Open Graph, sitemap). Set NEXT_PUBLIC_SITE_URL, or
// let Vercel's production URL be used; with neither, absolute URLs are simply left out.
export function siteUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : null;
}
