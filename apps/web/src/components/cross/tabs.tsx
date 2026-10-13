'use client';

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

export type TabDef = { id: string; label: string; content: ReactNode };

/**
 * Tabs that follow the WAI-ARIA pattern: one tab stop for the list, arrow keys / Home / End move and activate,
 * and the active tab lives in the URL hash (`#book`) so a view can be linked and survives reloads.
 * Every panel exists in the DOM so each tab's `aria-controls` resolves; only the active one has content.
 */
export function Tabs({ tabs, label, initial }: { tabs: TabDef[]; label: string; initial: string }) {
  const ids = tabs.map((t) => t.id);
  const [active, setActive] = useState(initial);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Read the hash after mount (the server cannot see it) and follow later changes (back/forward, edited URL).
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1);
      if (ids.includes(h)) setActive(h);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [ids.join('|')]);

  const select = useCallback((id: string, focus: boolean) => {
    setActive(id);
    try {
      window.history.replaceState(null, '', `#${id}`);
    } catch {
      // The tab still switches if the URL cannot be updated.
    }
    if (focus) refs.current[id]?.focus();
  }, []);

  const onKey = (e: KeyboardEvent, index: number) => {
    const last = ids.length - 1;
    const next = e.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    select(ids[next]!, true);
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={on}
              aria-controls={`panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => select(t.id, false)}
              onKeyDown={(e) => onKey(e, i)}
              className={`-mb-px shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${on ? 'border-accent-fill text-ink' : 'border-transparent text-muted hover:text-ink'}`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} tabIndex={0} hidden={t.id !== active} className="pt-6 focus-visible:outline-offset-4">
          {t.id === active ? t.content : null}
        </div>
      ))}
    </div>
  );
}
