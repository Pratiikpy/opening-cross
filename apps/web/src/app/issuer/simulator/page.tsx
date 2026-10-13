import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { StandaloneSimulator } from '@/components/issuer/standalone-simulator';

export const metadata: Metadata = { title: 'Launch simulator', description: 'Run the clearing rule, the print guards and the fees on your supply and a demand you enter, or on the soft commits of a draft listing.' };

export default function Page() {
  return (
    <>
      <PageHead title="Launch simulator" intro={<p>See what a cross would do with your supply and a demand, before you set anything on chain: the price it clears at, the raise, the float, the fees and who gets filled. It runs the program&apos;s own rules on numbers you enter. It is a model, not a forecast.</p>} />
      <StandaloneSimulator />
    </>
  );
}
