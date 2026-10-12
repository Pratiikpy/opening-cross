'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { MORE_NAV, NAV } from './nav-items';

const isCurrent = (pathname: string, href: string) => !href.includes('#') && (pathname === href || pathname.startsWith(`${href}/`));

export function DesktopNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="hidden items-center gap-7 text-sm text-muted md:flex">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} prefetch={false} aria-current={isCurrent(pathname, n.href) ? 'page' : undefined} className="transition-colors hover:text-ink aria-[current=page]:text-ink aria-[current=page]:underline aria-[current=page]:decoration-accent aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-[10px]">
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

/** Closes a <details> popover on Escape, on a click outside it, and when the route changes. */
export function useDismissableDetails(deps: unknown[] = []) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onPointer = (e: PointerEvent) => {
      if (d.open && e.target instanceof Node && !d.contains(e.target)) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && d.open) {
        d.open = false;
        d.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, deps);
  return ref;
}

export function MobileMenu() {
  const pathname = usePathname();
  const ref = useDismissableDetails([pathname]);
  return (
    <details ref={ref} className="relative md:hidden">
      <summary className="grid size-9 cursor-pointer list-none place-items-center rounded-full border border-border text-muted hover:text-ink [&::-webkit-details-marker]:hidden" aria-label="Menu">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>
      <nav aria-label="Main" className="absolute right-0 z-50 mt-2 w-56 rounded-[var(--radius-card)] border border-border bg-bg p-2 shadow-lg">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} prefetch={false} aria-current={isCurrent(pathname, n.href) ? 'page' : undefined} className="block rounded-lg px-3 py-2.5 text-sm hover:bg-surface aria-[current=page]:bg-surface aria-[current=page]:font-medium">
            {n.label}
          </Link>
        ))}
        <div className="my-1 border-t border-border" role="separator" />
        {MORE_NAV.map((n) => (
          <Link key={n.href} href={n.href} prefetch={false} aria-current={isCurrent(pathname, n.href) ? 'page' : undefined} className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-ink">
            {n.label}
          </Link>
        ))}
      </nav>
    </details>
  );
}
