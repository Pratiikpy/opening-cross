import type { Metadata } from 'next';
import { SeriesIndex } from '@/components/series/series-index';

export const metadata: Metadata = {
  title: 'Recurring series',
  description: 'Markets that reopen on a schedule: every recurring series on the network, its schedule, whether it is running or paused, and when its next cross closes.',
};

export default function Page() {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Recurring series</h1>
      <p className="mt-2 max-w-xl text-muted">
        A series is a market that reopens on a schedule: the same rules, a fresh price grid centred on the last price that printed, one cross at a time. The schedule and the rules are fixed when the series is created and cannot be edited, only paused.
      </p>
      <SeriesIndex />
    </div>
  );
}
