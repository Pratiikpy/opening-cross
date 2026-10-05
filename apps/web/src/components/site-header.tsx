import Link from 'next/link';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import { WalletButton } from './wallet-button';

export const NAV = [
  { href: '/crosses', label: 'Crosses' },
  { href: '/issue', label: 'Open a cross' },
  { href: '/#how', label: 'How it works' },
  { href: '/developers', label: 'Developers' },
  { href: '/status', label: 'Status' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Opening Bell home" className="text-ink">
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 text-sm text-muted md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="transition-colors hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <details className="relative md:hidden">
            <summary className="grid size-9 cursor-pointer list-none place-items-center rounded-full border border-border text-muted hover:text-ink [&::-webkit-details-marker]:hidden" aria-label="Menu">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </summary>
            <nav aria-label="Main" className="absolute right-0 z-50 mt-2 w-56 rounded-[var(--radius-card)] border border-border bg-bg p-2 shadow-lg">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="block rounded-lg px-3 py-2.5 text-sm hover:bg-surface">
                  {n.label}
                </Link>
              ))}
            </nav>
          </details>
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
