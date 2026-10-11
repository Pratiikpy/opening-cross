import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type Session, WalletUnavailableError, deauthorize, withWallet } from './mwa';
import type { Signer } from './tx';

const KEY = 'opening-bell:wallet';

type Ctx = {
  /** The authorised account, or null. */
  address: string | null;
  label: string | undefined;
  connecting: boolean;
  /** Opens the wallet to authorise this app; resolves with the address. */
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  /** Signs base64 transactions in one wallet session. Reauthorises silently with the stored token. */
  sign: Signer;
};

const WalletContext = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(KEY)
      .then((raw) => (raw ? setSession(JSON.parse(raw) as Session) : undefined))
      .catch(() => undefined);
  }, []);

  const remember = useCallback(async (s: Session | null) => {
    setSession(s);
    try {
      if (s) await AsyncStorage.setItem(KEY, JSON.stringify(s));
      else await AsyncStorage.removeItem(KEY);
    } catch {
      // The session still works for this run.
    }
  }, []);

  /** A rejected stored token is discarded and the wallet asked afresh, once. */
  const run = useCallback(
    async <T,>(use: Parameters<typeof withWallet<T>>[1]): Promise<T> => {
      try {
        const { result, session: s } = await withWallet(session?.authToken ?? null, use);
        await remember(s);
        return result;
      } catch (e) {
        if (session && !(e instanceof WalletUnavailableError) && e instanceof Error && /AUTHORIZATION_FAILED/i.test(`${e.name} ${e.message} ${String((e as { code?: unknown }).code)}`)) {
          await remember(null);
          const { result, session: s } = await withWallet(null, use);
          await remember(s);
          return result;
        }
        throw e;
      }
    },
    [session, remember],
  );

  const value = useMemo<Ctx>(
    () => ({
      address: session?.address ?? null,
      label: session?.label,
      connecting,
      connect: async () => {
        setConnecting(true);
        try {
          return await run(async (_w, s) => s.address);
        } finally {
          setConnecting(false);
        }
      },
      disconnect: async () => {
        const token = session?.authToken;
        await remember(null);
        if (token) await deauthorize(token).catch(() => undefined);
      },
      sign: (txs) => run(async (w) => w.sign(txs)),
    }),
    [session, connecting, run, remember],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): Ctx {
  const c = useContext(WalletContext);
  if (!c) throw new Error('useWallet must be used inside WalletProvider');
  return c;
}
