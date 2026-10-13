'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ISSUER_MENU, activeLink } from '@/lib/issuer-nav';

function Links({ path }: { path: string }) {
  const active = activeLink(path);
  return (
    <>
      {ISSUER_MENU.map((s) => (
        <div key={s.title}>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">{s.title}</p>
          <ul className="mt-1">
            {s.links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  prefetch={false}
                  aria-current={active === l.href ? 'page' : undefined}
                  className={`flex min-h-11 items-center rounded-lg px-3 text-sm transition-colors hover:bg-surface ${active === l.href ? 'bg-surface font-medium text-ink' : 'text-muted'}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The issuer menu: a column on a wide screen, a disclosure above the page on a narrow one. */
export function IssuerNav() {
  const path = usePathname();
  const current = ISSUER_MENU.flatMap((s) => s.links).find((l) => l.href === activeLink(path));
  return (
    <nav aria-label="Issuer" className="min-w-0">
      <details className="rounded-[var(--radius-card)] border border-border lg:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between px-4 text-sm">
          <span>
            <span className="text-muted">Issuer: </span>
            <span className="font-medium">{current?.label ?? 'Menu'}</span>
          </span>
        </summary>
        <div className="space-y-4 border-t border-border p-3">
          <Links path={path} />
        </div>
      </details>
      <div className="sticky top-24 hidden space-y-5 lg:block">
        <Links path={path} />
      </div>
    </nav>
  );
}
