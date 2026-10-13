import { imageResponse } from '@/lib/receipt-routes';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ address: string; owner: string }> }) {
  const { address, owner } = await ctx.params;
  return imageResponse(address, owner);
}
