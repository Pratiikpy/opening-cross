import { IssuerNav } from './issuer-nav';

/** The heading of an issuer page: one h1 and a short statement of what the page does. */
export function PageHead({ title, intro }: { title: string; intro?: React.ReactNode }) {
  return (
    <header>
      <h1 className="text-[34px] font-semibold leading-tight tracking-tight">{title}</h1>
      {intro ? <div className="mt-2 max-w-2xl text-muted">{intro}</div> : null}
    </header>
  );
}

/** The issuer area's frame: a section menu beside the page on a wide screen, above it on a narrow one. */
export function IssuerShell({ children, title, intro }: { children: React.ReactNode; title?: string; intro?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6 sm:py-12">
      <div className="grid gap-8 lg:grid-cols-[210px_minmax(0,1fr)]">
        <IssuerNav />
        <div className="min-w-0">
          {title ? <PageHead title={title} {...(intro ? { intro } : {})} /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
