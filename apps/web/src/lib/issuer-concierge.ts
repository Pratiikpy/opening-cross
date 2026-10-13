// The concierge is a checklist, not a chat: an ordered list of what an issuer must do to open a cross, each item judged from the
// state of the wizard, with the reason it matters and what to do next. There is no assistant and no human behind it; it never
// says something is done unless the form or the chain says so. The only time shown is how long the draft has been open, which is
// measured, not promised.
import type { ListingTypeId } from '@opening-cross/presets/launch';

export type StepStatus = 'done' | 'current' | 'todo' | 'optional' | 'later' | 'blocked';

export type StepId = 'type' | 'token' | 'quote' | 'grid' | 'window' | 'guards' | 'rules' | 'simulate' | 'gate' | 'wallet' | 'create' | 'treasury' | 'disclosure';

export type Step = {
  id: StepId;
  title: string;
  /** Why this step exists, in one sentence. */
  why: string;
  status: StepStatus;
  /** What is true now, or what to do next. */
  detail: string;
  /** The element on the page this step is about. */
  anchor: string;
};

/** What the wizard knows. Each flag is derived from the form or from a chain read, never from a click on the checklist. */
export type ConciergeState = {
  listingType: ListingTypeId | null;
  /** The listing type needs a licensed partner, so it cannot be created here. */
  typeNeedsPartner: boolean;
  baseMint: { entered: boolean; read: 'none' | 'ok' | 'failed'; blockers: number };
  quoteMint: { entered: boolean; read: 'none' | 'ok' | 'failed' };
  /** Field errors from the create-cross check, by field. */
  errors: Record<string, string>;
  /** The grid and schedule fields have values (they may still have errors). */
  gridFilled: boolean;
  minMatchedSet: boolean;
  guardsBlocked: boolean;
  /** The rules step: none set, set and accepted, set and refused or unreadable, or set and still being checked. */
  rules: 'off' | 'valid' | 'invalid' | 'pending';
  demandEntered: boolean;
  gate: 'none' | 'incomplete' | 'complete';
  walletConnected: boolean;
  /** The readiness checklist, once a wallet is connected and both mints are read. */
  readiness: 'unknown' | 'failing' | 'ready';
  /** An ownership-style listing whose preset advises a treasury, and whether the cross mints the coin. */
  treasury: 'recommended' | 'optional' | 'not-applicable';
};

const GRID_FIELDS = ['minPrice', 'tick', 'ticks', 'schedule'];
const WINDOW_FIELDS = ['openAt', 'closeAt', 'revealMinutes'];
const hasError = (errors: Record<string, string>, fields: string[]) => Object.keys(errors).some((k) => fields.some((f) => k === f || k.startsWith(`${f}.`)));

export function concierge(s: ConciergeState): Step[] {
  const steps: Step[] = [];
  const push = (x: Step) => steps.push(x);

  push({
    id: 'type',
    title: 'Choose what you are listing',
    why: 'The type picks a starting shape for the call and says which extra steps usually apply.',
    status: s.listingType === null ? 'todo' : s.typeNeedsPartner ? 'blocked' : 'done',
    detail:
      s.listingType === null
        ? 'Pick a listing type, or start from a token below and the page will suggest one.'
        : s.typeNeedsPartner
          ? 'This type needs a licensed partner and cannot be created from this page yet. The page says what is missing.'
          : 'Chosen. You can change it at any time; every field stays editable.',
    anchor: 'listing-type',
  });

  push({
    id: 'token',
    title: 'Read your token',
    why: 'The chain tells us whether your wallet can mint it, whether the supply is fixed, and whether any extension would stop a cross.',
    status: s.baseMint.read === 'ok' ? (s.baseMint.blockers > 0 ? 'blocked' : 'done') : s.baseMint.read === 'failed' ? 'blocked' : 'todo',
    detail:
      s.baseMint.read === 'ok'
        ? s.baseMint.blockers > 0
          ? 'The token cannot be used as it is. The reasons are listed under the token field.'
          : 'Read from the chain.'
        : s.baseMint.read === 'failed'
          ? 'The address could not be read as a token. Check it and read it again.'
          : s.baseMint.entered
            ? 'Press Check mint to read it.'
            : 'Paste the address of the token you are selling and press Check mint.',
    anchor: 'tokens',
  });

  push({
    id: 'quote',
    title: 'Choose what buyers pay with',
    why: 'Prices, fees and your proceeds are all in this token.',
    status: s.quoteMint.read === 'ok' ? 'done' : s.quoteMint.read === 'failed' ? 'blocked' : 'todo',
    detail:
      s.quoteMint.read === 'ok' ? 'Read from the chain.' : s.quoteMint.read === 'failed' ? 'The address could not be read as a token.' : 'Paste the payment token’s address, or pick one that other crosses already use.',
    anchor: 'tokens',
  });

  push({
    id: 'grid',
    title: 'Set the price grid and your supply',
    why: 'The cross can only clear at a price on the grid, and in a minting cross only the supply you list can be sold.',
    status: hasError(s.errors, GRID_FIELDS) ? (s.gridFilled ? 'blocked' : 'todo') : s.gridFilled ? 'done' : 'todo',
    detail: hasError(s.errors, GRID_FIELDS) ? 'A field is not valid yet. The message is shown on the field.' : s.gridFilled ? 'The grid and supply are valid.' : 'Enter the lowest price, the step, the number of levels and, for a minting cross, what you offer at which price.',
    anchor: 'grid',
  });

  push({
    id: 'window',
    title: 'Set when the call opens and closes',
    why: 'Orders are accepted only inside the window. Nothing can be changed once it opens.',
    status: hasError(s.errors, WINDOW_FIELDS) ? 'blocked' : 'done',
    detail: hasError(s.errors, WINDOW_FIELDS) ? 'The window is not valid yet.' : 'The window is valid.',
    anchor: 'window',
  });

  push({
    id: 'guards',
    title: 'Decide when the cross must not print',
    why: 'A cross that clears on too little demand sets a price from a handful of orders. Guards turn that into a refund for everyone.',
    status: s.guardsBlocked ? 'blocked' : s.minMatchedSet ? 'done' : 'todo',
    detail: s.guardsBlocked ? 'A guard as set would stop the cross ever printing.' : s.minMatchedSet ? 'A minimum volume is set.' : 'No minimum volume is set, so a very thin sale would still print. Set one, or keep none on purpose.',
    anchor: 'guards',
  });

  push({
    id: 'rules',
    title: 'Add rules for the ending, who is filled first and the team',
    why: 'Rules make the call harder to game and say who is filled first when a level is oversubscribed. They are written once, when the cross is created.',
    status: s.rules === 'off' ? 'optional' : s.rules === 'valid' ? 'done' : s.rules === 'invalid' ? 'blocked' : 'todo',
    detail:
      s.rules === 'off'
        ? 'Optional. Leave every rule off and the cross is created as it is today, or start from a preset.'
        : s.rules === 'valid'
          ? 'The rules are accepted. With a wallet connected, the creation transaction is measured too, and the readiness list shows how many bytes it uses.'
          : s.rules === 'invalid'
            ? 'A rule is refused, cannot be read, or the network cannot create a cross with rules yet. The reason is shown beside it.'
            : 'The rules are being checked against the grid, the window and the transaction size.',
    anchor: 'rules',
  });

  push({
    id: 'simulate',
    title: 'See what your setup does with demand',
    why: 'The simulator runs the clearing rule on your supply and a demand you enter, so surprises happen here and not on the day.',
    status: s.demandEntered ? 'done' : 'optional',
    detail: s.demandEntered ? 'You have run a simulation.' : 'Optional. Enter a demand, or use a finished cross’s real book, and read the result.',
    anchor: 'simulator',
  });

  push({
    id: 'gate',
    title: 'Decide who may bid',
    why: 'An open cross admits any wallet. A gate admits only wallets with a pass. Which rules an offering needs is for your counsel.',
    status: s.gate === 'incomplete' ? 'blocked' : s.gate === 'complete' ? 'done' : 'optional',
    detail: s.gate === 'incomplete' ? 'The gate you started is missing something.' : s.gate === 'complete' ? 'The gate is set.' : 'Optional. Leave it open, or add a gate.',
    anchor: 'gate',
  });

  push({
    id: 'wallet',
    title: 'Connect the wallet that will own the cross',
    why: 'Your wallet signs, pays the rent and holds the mint authority. This page never holds a key.',
    status: s.walletConnected ? (s.readiness === 'ready' ? 'done' : s.readiness === 'failing' ? 'blocked' : 'current') : 'todo',
    detail: !s.walletConnected ? 'Connect a wallet. Everything above works without one.' : s.readiness === 'ready' ? 'Every readiness check passes.' : s.readiness === 'failing' ? 'One or more readiness checks fail. They are listed with the fix.' : 'Check both mints so the chain can be read for this wallet.',
    anchor: 'readiness',
  });

  const everythingElse = steps.filter((x) => x.id !== 'create').every((x) => x.status === 'done' || x.status === 'optional');
  push({
    id: 'create',
    title: 'Create the cross',
    why: 'This signs the transactions that put the cross on chain.',
    status: s.typeNeedsPartner ? 'blocked' : everythingElse ? 'current' : 'todo',
    detail: s.typeNeedsPartner ? 'Not available for this listing type.' : everythingElse ? 'Ready. Review the cost, then create.' : 'Finish the steps above.',
    anchor: 'create',
  });

  if (s.treasury !== 'not-applicable') {
    push({
      id: 'treasury',
      title: 'After the cross: set up the treasury',
      why: 'The treasury holds proceeds under a spend allowance that releases only while an attestation you name is live. It can only be created once the coin’s supply is fixed, which happens when the cross finalizes.',
      status: 'later',
      detail: s.treasury === 'recommended' ? 'Recommended for this listing type. You will find it under Treasury in the issuer console.' : 'Optional for this listing type.',
      anchor: 'after',
    });
  }
  push({
    id: 'disclosure',
    title: 'After the cross: keep holders informed',
    why: 'Holders see a clock for when the next update is due. A signed update, anchored on chain, keeps it current.',
    status: 'later',
    detail: 'Post updates from the issuer console once a treasury exists.',
    anchor: 'after',
  });
  return steps;
}

/** The first step that is not done and not optional or later: what to do next. */
export function nextStep(steps: readonly Step[]): Step | null {
  return steps.find((x) => x.status === 'blocked') ?? steps.find((x) => x.status === 'todo' || x.status === 'current') ?? null;
}

/** "3 min" or "1 h 05 min" for how long a draft has been open. */
export function elapsed(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
}
