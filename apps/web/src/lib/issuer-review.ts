// The published readiness checklist (A2): what the console checks by itself, and what a reviewer looks at. The first list is the
// console's own readiness items, by id, so this page cannot promise a check the wizard does not make (a test holds the two together).
// The second list is the review criteria of this version. They are proposed: the people who review decide whether to adopt or change
// them, and nothing here is a legal opinion or an approval of any offering.
export type Criterion = { id: string; title: string; text: string };

/** Judged from the chain and the form, with no person involved. Each id is a readiness item of the wizard. */
export const AUTOMATIC: Criterion[] = [
  { id: 'authority', title: 'Mint authority matches how you sell', text: 'A minting cross needs your wallet to hold the token’s mint authority; a cross that sells from escrow needs no mint authority. The page reads it from the chain.' },
  { id: 'decimals', title: 'Both tokens can be read', text: 'The decimals of the token sold and of the payment token are read from the mints, so every price and amount is converted exactly.' },
  { id: 'programs', title: 'Token programs a cross can settle through', text: 'Only the classic SPL Token program and Token-2022 are handled, and a token with a transfer hook, a transfer fee or that is non-transferable is refused.' },
  { id: 'rent', title: 'SOL for rent and fees', text: 'Your wallet holds enough SOL for the rent of the cross, its book and its shards, and the network fees.' },
  { id: 'quote', title: 'The bond in the payment token', text: 'Your wallet holds the bond the program takes at creation (returned at settlement) in the payment token.' },
  { id: 'window', title: 'A valid call window', text: 'The call opens in the future by the network’s own clock and closes after it opens.' },
  { id: 'form', title: 'Every field is valid and on the grid', text: 'Prices fall on the price grid, amounts do not round, and the supply steps rise in price.' },
  { id: 'guard-volume', title: 'A minimum volume that can be reached', text: 'A minimum above the supply you list would stop the cross ever printing, so it is refused. Having no minimum is allowed, with a warning.' },
  { id: 'rule-float', title: 'Your float limit can be reached', text: 'If you set a minimum float, the supply you list must be able to reach it.' },
  { id: 'rule-fdv', title: 'Your value ceiling holds across the grid', text: 'If you set a highest fully diluted value, the top of your price grid must not exceed it.' },
];

/** Looked at by a reviewer. These are the criteria proposed for this version of the review. */
export const REVIEWED: Criterion[] = [
  { id: 'authenticity', title: 'The token is what you say it is', text: 'The token is not a copy of, or made to look like, a genuine token. The console shows the authenticity verdict where it can compute one; a reviewer looks at what it cannot.' },
  { id: 'powers', title: 'Powers over holders are disclosed', text: 'A freeze authority, a permanent delegate or any other power you hold over holders is stated plainly in your description. Buyers also see it on the cross page.' },
  { id: 'description', title: 'The description matches the mechanism', text: 'It says what holders get and do not get, in terms the program enforces. It does not promise returns, guarantee a price or imply an approval you do not have.' },
  { id: 'treasury', title: 'A plan for a treasury or its absence', text: 'For an ownership coin or revenue-share token: whether there is a treasury, who the attester is and what the attestation says, or why there is none.' },
  { id: 'disclosure', title: 'A disclosure plan', text: 'What you will report to holders and how often. Holders see a clock for it and know when it is late.' },
  { id: 'counsel', title: 'Advice for regulated offerings', text: 'For a tender, a stock token or any offering to the public, you confirm you have taken advice on whether it is permitted and to whom. You do not upload it: the reviewer asks whether you have.' },
  { id: 'team', title: 'Who is behind it', text: 'Who the team is and how to reach them, enough that a holder could find the people accountable. Applications are public: give only what you are content to publish.' },
];

export const LIMITS = [
  'Passing the checklist is not an approval, an endorsement or a legal opinion. The programs are not audited and this runs on Solana devnet only.',
  'A review is a decision by the people named as reviewers, recorded with their signature. If none are named, an application is stored and public but cannot be decided.',
  'The cross is permissionless: an application is optional and a cross can be opened without one. A review decides whether this product lists and promotes it, not whether it can exist on chain.',
];
