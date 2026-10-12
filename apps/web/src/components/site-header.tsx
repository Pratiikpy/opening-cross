import Link from 'next/link';
import { Logo } from './logo';
import { DesktopNav, MobileMenu } from './nav';
import { ThemeToggle } from './theme-toggle';
import { WalletButton } from './wallet-button';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Opening Bell home" className="text-ink">
          <Logo />
        </Link>
        <DesktopNav />
        <div className="flex items-center gap-2">
          <MobileMenu />
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
