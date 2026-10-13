// The issuer area's own menu. The site header carries three destinations (PRODUCT_FEATURES section 1); this area's pages are
// reached from this menu, which every page of the area shows.
export type IssuerLink = { href: string; label: string; hint: string };
export type IssuerSection = { title: string; links: IssuerLink[] };

export const ISSUER_MENU: IssuerSection[] = [
  {
    title: 'Raise',
    links: [
      { href: '/issue', label: 'Open a cross', hint: 'The wizard' },
      { href: '/issuer/simulator', label: 'Simulator', hint: 'Try a setup against demand' },
      { href: '/issuer/demand', label: 'Demand check', hint: 'Draft listings and soft commits' },
    ],
  },
  {
    title: 'Run',
    links: [
      { href: '/issuer', label: 'Overview', hint: 'Your crosses, holders and fees' },
      { href: '/issuer/treasury', label: 'Treasury', hint: 'Create it and read it' },
      { href: '/issuer/disclosures', label: 'Disclosures and Q&A', hint: 'Post updates, answer holders' },
    ],
  },
  {
    title: 'Grow',
    links: [
      { href: '/issuer/apply', label: 'Apply for review', hint: 'The checklist and your application' },
      { href: '/issuer/growth', label: 'Growth', hint: 'Playbooks, contacts, referrals' },
      { href: '/issuer/accelerators', label: 'Accelerators', hint: 'For cohort companies' },
    ],
  },
];

/** The link whose address is the longest prefix of the path, so /issuer/treasury/new highlights Treasury and /issuer highlights Overview only on itself. */
export function activeLink(path: string): string | null {
  const all = ISSUER_MENU.flatMap((s) => s.links.map((l) => l.href));
  const matches = all.filter((h) => (h === '/issuer' || h === '/issue' ? path === h : path === h || path.startsWith(`${h}/`)));
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}
