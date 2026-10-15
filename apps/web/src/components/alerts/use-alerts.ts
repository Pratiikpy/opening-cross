'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { type AlertConfig, type Feed, type Saved, SAVED_KEY, WATCH_KEY, type Watch, type WatchKind, allWatched, getAlertConfig, getFeed, loadSaved, loadWatch, parseSaved, parseWatch, subscriptionStatus, toggleWatch, updateSubscription, writeSaved, writeWatch } from '@/lib/holder-alerts';

// Browser storage as a store React can subscribe to: the same value on the server and in the first client render (nothing saved),
// then the saved one, and an update in one tab reaches the others.
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SAVED_KEY || e.key === WATCH_KEY || e.key === null) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

const raw = (key: string) => () => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const readSaved = raw(SAVED_KEY);
const readWatch = raw(WATCH_KEY);

export function useSaved(): { saved: Saved; set: (s: Saved) => boolean } {
  const text = useSyncExternalStore(subscribe, readSaved, () => '');
  const set = useCallback((s: Saved) => {
    const ok = writeSaved(s);
    emit();
    return ok;
  }, []);
  return { saved: parseSaved(text), set };
}

/** What this browser follows. `follow` flips one address and tells the server's subscriptions about the new list. */
export function useWatchList(): { watch: Watch; follow: (kind: WatchKind, address: string) => Promise<{ saved: boolean; following: boolean }>; setWatch: (next: Watch) => boolean } {
  const text = useSyncExternalStore(subscribe, readWatch, () => '');
  const follow = useCallback(async (kind: WatchKind, address: string) => {
    const before = loadWatch();
    const next = toggleWatch(before, kind, address);
    const saved = writeWatch(next);
    emit();
    // The subscriptions this browser manages follow the same list. A failure here leaves the local list as the user set it.
    const s = loadSaved();
    await Promise.all([s.push, s.telegram].filter((x): x is NonNullable<typeof x> => x !== null).map((m) => updateSubscription(m.id, m.token, { watch: allWatched(next) })));
    return { saved, following: next[kind].includes(address) };
  }, []);
  const setWatch = useCallback((next: Watch) => {
    const ok = writeWatch(next);
    emit();
    return ok;
  }, []);
  return { watch: parseWatch(text), follow, setWatch };
}

export function useAlertConfig(): { config: AlertConfig | null; error: string | null } {
  const [state, setState] = useState<{ config: AlertConfig | null; error: string | null }>({ config: null, error: null });
  useEffect(() => {
    let live = true;
    void getAlertConfig().then((r) => live && setState(r.ok ? { config: r.data, error: null } : { config: null, error: r.error }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** What needs attention now for a wallet and the things followed. Reloads every 30 seconds while the page is open. */
export function useFeed(wallet: string | null, watch: readonly string[]): { feed: Feed | null; error: string | null; loading: boolean } {
  const key = `${wallet ?? ''}|${watch.join(',')}`;
  const [state, setState] = useState<{ feed: Feed | null; error: string | null; loading: boolean; key: string }>({ feed: null, error: null, loading: true, key });
  useEffect(() => {
    if (!wallet && watch.length === 0) {
      setState({ feed: null, error: null, loading: false, key });
      return;
    }
    let live = true;
    const load = () =>
      void getFeed(wallet, watch).then((r) => live && setState({ feed: r.ok ? r.data : null, error: r.ok ? null : r.error, loading: false, key }));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // `key` carries the wallet and the list, so the effect restarts exactly when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { feed: state.key === key ? state.feed : null, error: state.key === key ? state.error : null, loading: state.key !== key || state.loading };
}

export { subscriptionStatus };
