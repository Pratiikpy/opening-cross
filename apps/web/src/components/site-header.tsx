import Link from 'next/link';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

export const NAV = [
  { href: '/#how', label: 'How it works' },
  { href: '/#proof', label: 'Proof' },
  { href: '/#issuers', label: 'Issuers' },
  { href: '/#developers', label: 'Developers' },
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
          <ThemeToggle />
          <a
            href="https://github.com/Pratiikpy/opening-cross"
            className="hidden rounded-full bg-ink px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 sm:inline-block"
          >
            Source code
          </a>
        </div>
      </div>
    </header>
  );
}
