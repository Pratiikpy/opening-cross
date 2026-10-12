import { useCallback, useEffect, useState } from 'react';
import { ActionError, type SealedBid, importBackup, serializeBackup } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';

export type UseSealedBids = {
  bids: SealedBid[];
  /** Offers the vault's bids for this cross and wallet as a backup file the owner keeps. Returns false when the browser could not start a download. */
  download: () => boolean;
  /** Loads a backup file's text into the vault (the web app's backups work too); returns how many bids belong to this cross and wallet. */
  restore: (text: string) => Promise<number>;
  refresh: () => Promise<void>;
};

/** Triggers a browser download of `text`. False when there is no DOM to do it with. */
export function downloadText(filename: string, text: string, type = 'application/json'): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * The sealed bids this wallet placed in a cross. A sealed bid is only a hash on chain: the price, amount and salt needed to reveal it live
 * in the vault (and in the backup), never anywhere else. Losing them means the bid cannot be revealed and is refunded in full at settlement.
 */
export function useSealedBids(cross: string | null, owner: string | null, version = 0): UseSealedBids {
  const { store } = useOpeningCross();
  const [bids, setBids] = useState<SealedBid[]>([]);
  const refresh = useCallback(async () => {
    setBids(cross && owner ? await store.list(cross, owner) : []);
  }, [store, cross, owner]);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  return {
    bids,
    refresh,
    download: () => downloadText(`sealed-bids-${cross?.slice(0, 8) ?? 'empty'}.json`, serializeBackup(bids)),
    restore: async (text) => {
      if (!cross || !owner) throw new ActionError('Connect a wallet first.', 'INVALID_INPUT');
      const n = await importBackup(store, text, cross, owner);
      await refresh();
      return n;
    },
  };
}
