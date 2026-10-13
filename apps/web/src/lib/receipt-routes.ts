// Shared handlers behind the receipt routes (image and JSON, cross and wallet), so the four route files stay one line each.
import { noticeImage, receiptImage } from '@/components/cross/receipt-image';
import { NoReceiptError, UnsupportedProofError } from './receipt';
import { type LoadedReceipt, ReceiptLoadError, loadReceipt } from './receipt-load';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddress = (s: string): boolean => BASE58.test(s);

const ttl = (r: LoadedReceipt['receipt']) => (r.result.state === 'Finalized' ? 3600 : 60);

export async function imageResponse(address: string, owner?: string): Promise<Response> {
  if (!isAddress(address) || (owner !== undefined && !isAddress(owner))) return new Response('not a Solana address', { status: 404 });
  try {
    const { receipt, sha256 } = await loadReceipt(address, owner);
    return receiptImage(receipt, sha256, ttl(receipt));
  } catch (e) {
    if (e instanceof NoReceiptError) return noticeImage('Not settled yet', 'A receipt exists once the cross has cleared.');
    if (e instanceof UnsupportedProofError) return noticeImage('Receipt unavailable', 'The proof of this cross uses a schema this page cannot restate.');
    if (e instanceof ReceiptLoadError && e.status === 404) return new Response('no such cross', { status: 404 });
    return noticeImage('Receipt unavailable', 'The Opening Cross API could not be read just now.');
  }
}

/** The canonical receipt bytes: `sha256sum` of the body is the receipt hash, also sent as x-receipt-sha256. */
export async function jsonResponse(address: string, owner?: string): Promise<Response> {
  if (!isAddress(address) || (owner !== undefined && !isAddress(owner))) return Response.json({ error: 'not a Solana address' }, { status: 404 });
  try {
    const { canonical, sha256, receipt } = await loadReceipt(address, owner);
    return new Response(canonical, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="opening-cross-receipt-${address.slice(0, 8)}${owner ? `-${owner.slice(0, 8)}` : ''}.json"`,
        'x-receipt-sha256': sha256,
        'cache-control': `public, max-age=${ttl(receipt)}`,
      },
    });
  } catch (e) {
    if (e instanceof NoReceiptError) return Response.json({ error: e.message }, { status: 409 });
    if (e instanceof UnsupportedProofError) return Response.json({ error: e.message }, { status: 422 });
    if (e instanceof ReceiptLoadError) return Response.json({ error: e.message }, { status: e.status === 404 ? 404 : 503 });
    throw e;
  }
}
