'use client';

import { ReleaseNotice } from '@/components/cross/release-notice';
import { usePrograms } from '@/lib/holder-programs';

const CARDS = 'The extension the cards below describe (votes, redemption at NAV, distributions, revenue rounds, grants, disclosure requests)';

/** Said once on a treasury screen: whether the extension it describes is deployed on this network. Silent when it is. */
export function RightsReleaseNote({ what = CARDS }: { what?: string }) {
  const programs = usePrograms();
  return (
    <div className="mt-8 max-w-3xl">
      <ReleaseNotice programs={programs} program="treasury" what={what} />
    </div>
  );
}
