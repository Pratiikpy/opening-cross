// Every instruction of the seven Wave 3D programs with its discriminator, for the release report (GET /v1/programs) and for tests that decode a built transaction.
import {
  ATTEST_DISCRIMINATOR,
  CHECK_DISCRIMINATOR,
  CREATE_POLICY_DISCRIMINATOR,
} from '@opening-cross/cross-backing-client';
import { CREATE_BASKET_DISCRIMINATOR, MINT_SHARES_DISCRIMINATOR, REDEEM_SHARES_DISCRIMINATOR } from '@opening-cross/cross-basket-client';
import {
  AWARD_DISCRIMINATOR,
  CLAIM_INVARIANT_DISCRIMINATOR,
  CREATE_BOUNTY_DISCRIMINATOR,
  FUND_DISCRIMINATOR as BOUNTY_FUND_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR as BOUNTY_WITHDRAW_DISCRIMINATOR,
} from '@opening-cross/cross-bounty-client';
import { CLAIM_BADGE_DISCRIMINATOR, CLOSE_LOCK_DISCRIMINATOR, INIT_BADGE_DISCRIMINATOR, LOCK_TOKENS_DISCRIMINATOR, UNLOCK_DISCRIMINATOR } from '@opening-cross/cross-conviction-client';
import {
  CAST_VOTE_DISCRIMINATOR,
  FINALIZE_ROUND_DISCRIMINATOR,
  INIT_CHARTER_DISCRIMINATOR,
  POST_VOLUME_DISCRIMINATOR,
  PUBLISH_OUTCOME_DISCRIMINATOR,
  START_ROUND_DISCRIMINATOR,
  WITHDRAW_VOTE_DISCRIMINATOR,
} from '@opening-cross/cross-graduate-client';
import {
  CREATE_VENUE_DISCRIMINATOR,
  DEPOSIT_BOND_DISCRIMINATOR,
  LIST_CROSS_DISCRIMINATOR,
  OPEN_BOND_DISCRIMINATOR,
  RELEASE_LISTING_DISCRIMINATOR,
  SLASH_LISTING_DISCRIMINATOR,
  WITHDRAW_BOND_DISCRIMINATOR,
} from '@opening-cross/cross-listing-client';
import {
  CANCEL_ORDER_DISCRIMINATOR,
  CREATE_MANDATE_DISCRIMINATOR,
  FUND_DISCRIMINATOR as MANDATE_FUND_DISCRIMINATOR,
  PLACE_ORDER_DISCRIMINATOR,
  REVEAL_ORDER_DISCRIMINATOR,
  REVOKE_DISCRIMINATOR,
  SET_LIMITS_DISCRIMINATOR,
  SWEEP_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR as MANDATE_WITHDRAW_DISCRIMINATOR,
  WITHDRAW_LAMPORTS_DISCRIMINATOR,
} from '@opening-cross/cross-mandate-client';
import type { NewProgramKey } from './programs-support.js';

type Disc = Uint8Array;
const d = (x: unknown) => x as Disc;

export const NEW_PROGRAM_INSTRUCTIONS: Record<NewProgramKey, [string, Disc][]> = {
  crossMandate: [
    ['create_mandate', d(CREATE_MANDATE_DISCRIMINATOR)],
    ['fund', d(MANDATE_FUND_DISCRIMINATOR)],
    ['set_limits', d(SET_LIMITS_DISCRIMINATOR)],
    ['revoke', d(REVOKE_DISCRIMINATOR)],
    ['withdraw', d(MANDATE_WITHDRAW_DISCRIMINATOR)],
    ['withdraw_lamports', d(WITHDRAW_LAMPORTS_DISCRIMINATOR)],
    ['sweep', d(SWEEP_DISCRIMINATOR)],
    ['place_order', d(PLACE_ORDER_DISCRIMINATOR)],
    ['reveal_order', d(REVEAL_ORDER_DISCRIMINATOR)],
    ['cancel_order', d(CANCEL_ORDER_DISCRIMINATOR)],
  ],
  crossConviction: [
    ['lock_tokens', d(LOCK_TOKENS_DISCRIMINATOR)],
    ['unlock', d(UNLOCK_DISCRIMINATOR)],
    ['init_badge', d(INIT_BADGE_DISCRIMINATOR)],
    ['claim_badge', d(CLAIM_BADGE_DISCRIMINATOR)],
    ['close_lock', d(CLOSE_LOCK_DISCRIMINATOR)],
  ],
  crossBasket: [
    ['create_basket', d(CREATE_BASKET_DISCRIMINATOR)],
    ['mint_shares', d(MINT_SHARES_DISCRIMINATOR)],
    ['redeem_shares', d(REDEEM_SHARES_DISCRIMINATOR)],
  ],
  crossListing: [
    ['create_venue', d(CREATE_VENUE_DISCRIMINATOR)],
    ['open_bond', d(OPEN_BOND_DISCRIMINATOR)],
    ['deposit_bond', d(DEPOSIT_BOND_DISCRIMINATOR)],
    ['withdraw_bond', d(WITHDRAW_BOND_DISCRIMINATOR)],
    ['list_cross', d(LIST_CROSS_DISCRIMINATOR)],
    ['release_listing', d(RELEASE_LISTING_DISCRIMINATOR)],
    ['slash_listing', d(SLASH_LISTING_DISCRIMINATOR)],
  ],
  crossBounty: [
    ['create_bounty', d(CREATE_BOUNTY_DISCRIMINATOR)],
    ['fund', d(BOUNTY_FUND_DISCRIMINATOR)],
    ['claim_invariant', d(CLAIM_INVARIANT_DISCRIMINATOR)],
    ['award', d(AWARD_DISCRIMINATOR)],
    ['withdraw', d(BOUNTY_WITHDRAW_DISCRIMINATOR)],
  ],
  crossBacking: [
    ['create_policy', d(CREATE_POLICY_DISCRIMINATOR)],
    ['attest', d(ATTEST_DISCRIMINATOR)],
    ['check', d(CHECK_DISCRIMINATOR)],
  ],
  crossGraduate: [
    ['init_charter', d(INIT_CHARTER_DISCRIMINATOR)],
    ['start_round', d(START_ROUND_DISCRIMINATOR)],
    ['cast_vote', d(CAST_VOTE_DISCRIMINATOR)],
    ['post_volume', d(POST_VOLUME_DISCRIMINATOR)],
    ['finalize_round', d(FINALIZE_ROUND_DISCRIMINATOR)],
    ['publish_outcome', d(PUBLISH_OUTCOME_DISCRIMINATOR)],
    ['withdraw_vote', d(WITHDRAW_VOTE_DISCRIMINATOR)],
  ],
};
