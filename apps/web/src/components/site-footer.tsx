import Link from 'next/link';
import { Logo } from './logo';
import { MORE_NAV, NAV } from './nav-items';

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-sm text-sm text-muted">
            Opening Bell is the app. Opening Cross is the open protocol underneath it, Apache-2.0 licensed.
          </p>
        </div>
        <nav aria-label="Footer" className="space-y-2 text-sm">
          <p className="font-medium">Opening Bell</p>
          {[...NAV.slice(0, 2), { href: '/#how', label: 'How it works' }, MORE_NAV[4]!, { href: '/#proof', label: 'Proof' }, { href: '/#issuers', label: 'For issuers' }, { href: '/orders', label: 'My orders' }].map((n) => (
            <Link key={n.href} href={n.href} prefetch={false} className="block text-muted hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Trust and developers" className="space-y-2 text-sm">
          <p className="font-medium">Check the work</p>
          {[MORE_NAV[1]!, MORE_NAV[2]!, MORE_NAV[3]!, NAV[2]!].map((n) => (
            <Link key={n.href} href={n.href} prefetch={false} className="block text-muted hover:text-ink">
              {n.label}
            </Link>
          ))}
          <a className="block text-muted hover:text-ink" href="/llms.txt">For AI agents (llms.txt)</a>
          <a className="block text-muted hover:text-ink" href="https://github.com/Pratiikpy/opening-cross/tree/main/docs/adr">Design decisions</a>
          <a className="block text-muted hover:text-ink" href="https://github.com/Pratiikpy/opening-cross/blob/main/docs/ROADMAP.md">Roadmap</a>
          <a className="block text-muted hover:text-ink" href="https://github.com/Pratiikpy/opening-cross">GitHub</a>
        </nav>
      </div>
      <div className="mx-auto max-w-[1200px] border-t border-border px-4 py-6 text-xs text-muted sm:px-6">
        Early development. Opening Cross runs on Solana devnet and is not deployed to mainnet. Nothing on this site is an offer of
        securities or investment advice. Buying new assets is risky: you can lose what you pay.
      </div>
    </footer>
  );
}
