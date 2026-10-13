import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { type ClaimScan, claimBody, scanClaims } from '../lib/claims';
import { build, failureText, signSendConfirm } from '../lib/tx';
import { formatAtoms, shortAddress } from '../lib/units';
import { useWallet } from '../lib/wallet';
import { Button, Card, Notice, Txt } from './components';

/** The claim center: every order that can be paid out or refunded now, claimed together in one wallet session. */
export function ClaimCenter({ owner, onChanged }: { owner: string; onChanged: () => void }) {
  const wallet = useWallet();
  const [scan, setScan] = useState<ClaimScan | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const load = useCallback(async () => setScan(await scanClaims(owner)), [owner]);
  useEffect(() => {
    void load();
  }, [load]);

  async function claimAll() {
    if (!scan || scan.claimable.length === 0) return;
    setError(null);
    setStatus('Preparing…');
    try {
      const txs = [];
      for (const c of scan.claimable) txs.push(...(await build('/v1/tx/claim', claimBody(c, owner))).txs);
      const sigs = await signSendConfirm(txs, wallet.sign, setStatus);
      setDone(sigs.length);
      await load();
      onChanged();
    } catch (e) {
      // A refund can be pushed by a keeper before this wallet claims it. Read the chain again so a row paid out meanwhile leaves the list.
      const before = scan?.claimable.length ?? 0;
      const fresh = await scanClaims(owner);
      setScan(fresh);
      const gone = before - fresh.claimable.length;
      setError(gone > 0 ? `${gone} order${gone === 1 ? ' was' : 's were'} paid out on chain before you claimed (a keeper may refund an order that has no fill). The list is up to date; claim again for what is left.` : failureText(e));
    } finally {
      setStatus(null);
    }
  }

  return (
    <Card>
      <Txt variant="heading">Claim center</Txt>
      {scan === null ? (
        <Txt variant="small" tone="muted" style={{ marginTop: 8 }}>
          Checking the chain for orders that can be claimed…
        </Txt>
      ) : scan.failed ? (
        <Notice tone="error">The Opening Cross API could not be reached, so claims cannot be listed. Pull down to try again.</Notice>
      ) : scan.claimable.length === 0 ? (
        <Txt variant="small" tone="muted" style={{ marginTop: 8 }}>
          {scan.checked ? 'Nothing to claim. An order appears here once its cross has cleared or did not print and it has not been paid out.' : 'The chain could not be read for some orders, so some claims may be missing. Pull down to try again.'}
        </Txt>
      ) : (
        <View style={{ gap: 10, marginTop: 10 }}>
          {scan.claimable.map((c) => (
            <View key={c.order.address}>
              <Txt variant="body">
                {c.order.side === 'buy' ? 'Buy' : 'Sell'} in {shortAddress(c.cross.address)}: {c.kind === 'no-print' ? 'did not print, refund due' : 'cleared, unclaimed'}
              </Txt>
              <Txt variant="small" tone="muted">
                escrow {formatAtoms(BigInt(c.order.escrow), c.order.side === 'buy' ? c.cross.decimals.quote : c.cross.decimals.base)} {c.order.side === 'buy' ? 'quote' : 'tokens'}
              </Txt>
              {c.kind === 'no-print' ? (
                <Txt variant="small" tone="muted">
                  Nothing traded, so anyone can send this refund and it always goes to your wallet. A keeper may do it first.
                </Txt>
              ) : null}
            </View>
          ))}
          <Txt variant="small" tone="muted">
            All of them are claimed in one wallet session, one transaction each.
          </Txt>
          <Button label={status ?? `Claim all (${scan.claimable.length})`} busy={status !== null} onPress={() => void claimAll()} />
        </View>
      )}
      {done > 0 && scan?.claimable.length === 0 ? (
        <Txt variant="small" tone="positive" style={{ marginTop: 8 }}>
          {done} claim{done === 1 ? '' : 's'} confirmed.
        </Txt>
      ) : null}
      {error ? (
        <Txt variant="small" tone="accent" style={{ marginTop: 8 }}>
          {error}
        </Txt>
      ) : null}
    </Card>
  );
}
