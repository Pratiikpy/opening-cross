// One-purpose buttons over ActionButton: claim, reveal, cancel, settle, finalize. Each builds through the provider's builder and
// signs with the provider's wallet. They render nothing useful for a wallet that is not connected: the button is disabled.
import { type CrossDetail, bytesOfHex } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useSealedBids } from '../hooks/use-sealed-bids.js';
import { ActionButton, type ActionButtonProps } from './action-button.js';

type Common = Pick<ActionButtonProps, 'onDone' | 'onPartial' | 'disabled' | 'className' | 'testId'> & { variant?: ActionButtonProps['variant'] };

export type ClaimButtonProps = Common & {
  cross: CrossDetail;
  /** The order's owner. Anyone may send the claim; the proceeds always go to the owner. */
  owner: string;
  nonce: string;
};

/** Collects an order's fill and refund after the cross settles. Labelled for what it will do: a refund only when the cross did not print. */
export function ClaimButton({ cross, owner, nonce, ...rest }: ClaimButtonProps) {
  const { builder, wallet } = useOpeningCross();
  const settled = cross.state === 'Cleared' || cross.state === 'NoPrint';
  return (
    <ActionButton
      {...rest}
      label={cross.state === 'NoPrint' ? 'Claim refund' : 'Claim fill and refund'}
      disabled={rest.disabled || !settled}
      action={() => builder.claim({ cross: cross.address, owner, nonce: BigInt(nonce), payer: wallet?.address ?? owner })}
    />
  );
}

export type RevealButtonProps = Common & { cross: CrossDetail; owner: string; nonce: string };

/** Reveals a sealed bid after the call closes, using the price, amount and salt kept in the vault. Explains when they are not there. */
export function RevealButton({ cross, owner, nonce, ...rest }: RevealButtonProps) {
  const { builder } = useOpeningCross();
  const { bids } = useSealedBids(cross.address, owner);
  const bid = bids.find((b) => b.nonce === nonce);
  return (
    <>
      <ActionButton
        {...rest}
        label="Reveal bid"
        disabled={rest.disabled || !bid}
        action={() => builder.reveal({ cross: cross.address, owner, nonce: BigInt(nonce), price: BigInt(bid!.price), quantity: BigInt(bid!.quantity), salt: bytesOfHex(bid!.salt) })}
      />
      {!bid ? <p className="oc-hint">This browser does not have the details of this bid. Load your reveal backup to reveal it.</p> : null}
    </>
  );
}

export type CancelButtonProps = Common & { cross: CrossDetail; owner: string; nonce: string };

/** Withdraws an order while the cross is open. Full refund, no fee. */
export function CancelButton({ cross, owner, nonce, ...rest }: CancelButtonProps) {
  const { builder } = useOpeningCross();
  return <ActionButton variant="secondary" {...rest} label="Cancel order" action={() => builder.cancel({ cross: cross.address, owner, nonce: BigInt(nonce) })} />;
}

export type SettleButtonProps = Common & { cross: CrossDetail; oraclePrice?: string };

/** Settles a cross after its call and reveal window: merge every shard, then clear. Anyone may. */
export function SettleButton({ cross, oraclePrice, ...rest }: SettleButtonProps) {
  const { builder, wallet } = useOpeningCross();
  return <ActionButton {...rest} label="Settle cross" action={() => builder.settle({ cross: cross.address, payer: wallet!.address, ...(oraclePrice ? { oraclePrice } : {}) })} />;
}

export type FinalizeButtonProps = Common & { cross: CrossDetail };

/** Pays the fees and the issuer's proceeds once every order has been claimed. Anyone may. */
export function FinalizeButton({ cross, ...rest }: FinalizeButtonProps) {
  const { builder, wallet } = useOpeningCross();
  return <ActionButton {...rest} label="Finalize cross" action={() => builder.finalize({ cross: cross.address, payer: wallet!.address })} />;
}
