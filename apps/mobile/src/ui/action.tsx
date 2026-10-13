import { useState } from 'react';
import { View } from 'react-native';
import { build, failureText, signSendConfirm } from '../lib/tx';
import { useWallet } from '../lib/wallet';
import { Button, Txt } from './components';

/** Builds via the API, signs in the wallet over MWA, sends, confirms; shows each step and any refusal. */
export function ActionButton({
  label,
  path,
  body,
  onDone,
  variant = 'primary',
  disabled,
  before,
}: {
  label: string;
  path: string;
  body: () => unknown;
  onDone: (signatures: string[], extra: Record<string, unknown>) => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  /** Runs before anything is built; throw an ActionError to stop with a message. May be async. */
  before?: () => void | Promise<void>;
}) {
  const wallet = useWallet();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={status ?? label}
        variant={variant}
        disabled={disabled}
        busy={status !== null}
        onPress={async () => {
          setError(null);
          setStatus('Preparing…');
          try {
            await before?.();
            const { txs, extra } = await build(path, body());
            const sigs = await signSendConfirm(txs, wallet.sign, setStatus);
            onDone(sigs, extra);
          } catch (e) {
            setError(failureText(e));
          } finally {
            setStatus(null);
          }
        }}
      />
      {error ? (
        <Txt variant="small" tone="accent">
          {error}
        </Txt>
      ) : null}
    </View>
  );
}
