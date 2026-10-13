import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { NoReceiptError, UnsupportedProofError } from '@/lib/receipt';
import { ReceiptLoadError, loadReceipt } from '@/lib/receipt-load';
import { isAddress } from '@/lib/receipt-routes';
import { shortAddress } from '@/lib/units';
import { ReceiptView } from './receipt-view';

const paths = (address: string, owner?: string) => {
  const base = `/receipt/${address}${owner ? `/${owner}` : ''}`;
  return { pagePath: base, imagePath: `${base}/image`, jsonPath: `${base}/json` };
};

export async function receiptMetadata(address: string, owner?: string): Promise<Metadata> {
  const title = `${owner ? 'Order receipt' : 'Receipt'} for cross ${shortAddress(address)}`;
  const description = 'What the chain recorded for this cross and whether an independent recomputation matches it.';
  // The card is only offered for sharing once there is a result to show.
  const ready = isAddress(address) && (await loadReceipt(address, owner).then(() => true, () => false));
  const images = ready ? [{ url: paths(address, owner).imagePath, width: 1200, height: 630, alt: title }] : [];
  return { title, description, openGraph: { title, description, images }, twitter: { card: ready ? 'summary_large_image' : 'summary', title, description, ...(ready ? { images: [paths(address, owner).imagePath] } : {}) } };
}

export async function ReceiptPage({ address, owner }: { address: string; owner?: string }) {
  if (!isAddress(address) || (owner !== undefined && !isAddress(owner))) notFound();
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('host') ?? 'localhost'}`;
  let loaded: Awaited<ReturnType<typeof loadReceipt>>;
  try {
    loaded = await loadReceipt(address, owner);
  } catch (e) {
    if (e instanceof ReceiptLoadError && e.status === 404) notFound();
    const message = e instanceof NoReceiptError || e instanceof UnsupportedProofError ? e.message : e instanceof ReceiptLoadError ? `The API could not be read right now: ${e.message}.` : 'The receipt could not be built.';
    return (
      <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
        <h1 className="text-2xl font-semibold">Receipt for cross {shortAddress(address)}</h1>
        <p role="status" className="mt-4 text-muted">
          {message}
        </p>
        <p className="mt-3 text-sm">
          <a className="text-accent-text underline underline-offset-4" href={`/crosses/${address}`}>Open the cross</a>
        </p>
      </div>
    );
  }
  return <ReceiptView receipt={loaded.receipt} sha256={loaded.sha256} origin={origin} {...paths(address, owner)} />;
}
