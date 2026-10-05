// Pyth price accounts for the oracle guard. Mirrors `cross_core::oracle` so clients can preview
// exactly what the program will decide.
import { type Address, address, getProgramDerivedAddress } from '@solana/kit';

/** Pyth receivers and push-oracle programs before and after the 26 Aug 2026 Pyth Core upgrade. */
export const PYTH_RECEIVER = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
export const PYTH_RECEIVER_UPGRADED = address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp');
export const PYTH_PUSH_ORACLE = address('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
export const PYTH_PUSH_ORACLE_UPGRADED = address('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
export const isPythReceiver = (owner: Address) => owner === PYTH_RECEIVER || owner === PYTH_RECEIVER_UPGRADED;
const DISCRIMINATOR = [34, 241, 35, 99, 157, 126, 244, 205];

export type OraclePrice = { feedId: Uint8Array; price: bigint; exponent: number; publishTime: bigint; fullyVerified: boolean };

/** Push-oracle feed account for a Pyth feed id: PDA of the push-oracle program with seeds
 *  `[shard_id as u16 LE, feed_id]`. */
export async function pythFeedAccount(feedIdHex: string, shard = 0, program: Address = PYTH_PUSH_ORACLE_UPGRADED): Promise<Address> {
  const shardLe = new Uint8Array([shard & 0xff, (shard >> 8) & 0xff]);
  return (await getProgramDerivedAddress({ programAddress: program, seeds: [shardLe, hexToBytes(feedIdHex)] }))[0];
}

export function parsePriceUpdate(data: Uint8Array): OraclePrice | null {
  if (data.length < 8 + 32 + 1 + 32 + 28 || DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 40;
  const level = data[at];
  if (level !== 0 && level !== 1) return null;
  at += level === 0 ? 2 : 1;
  const feedId = data.slice(at, at + 32);
  at += 32;
  const price = view.getBigInt64(at, true);
  at += 16;
  const exponent = view.getInt32(at, true);
  at += 4;
  const publishTime = view.getBigInt64(at, true);
  return { feedId, price, exponent, publishTime, fullyVerified: level === 1 };
}

/** Oracle price in cross units (quote atoms per `priceScale` base atoms), or null. */
export function oracleToCrossUnits(o: OraclePrice, quoteDecimals: number, baseDecimals: number, priceScale: bigint): bigint | null {
  if (o.price <= 0n) return null;
  const shift = o.exponent + quoteDecimals - baseDecimals;
  const v = shift >= 0 ? o.price * priceScale * 10n ** BigInt(shift) : (o.price * priceScale) / 10n ** BigInt(-shift);
  return v > 0n ? v : null;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}
