// Presets for the issuer form. The definitions live in packages/presets (`launch`), where they are tested on their own; this file
// only turns one into the form's values. A preset fills fields the issuer can see and change; it never picks a price or a supply,
// because those belong to the token being issued. It is a starting shape, not advice about what a good raise looks like.
import { LAUNCH_PRESETS, type LaunchPreset, type LaunchPresetFields, stepAtoms } from '@opening-cross/presets/launch';
import { formatAtoms, parseAtoms } from './units';

export type PresetFields = LaunchPresetFields;
export type Preset = LaunchPreset;
export const PRESETS: readonly Preset[] = LAUNCH_PRESETS;

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * The form values a preset sets. The step is `stepBps` of the lowest price when that is exact at the quote token's decimals; otherwise
 * the current step stays, and `stepKept` says so. The supply schedule is only kept (never invented) and the lowest price is never touched.
 */
export function applyPreset(p: Preset, current: { minPrice: string; tick: string; quoteDecimals: number | null }, now: Date) {
  const f = p.fields;
  let tick = current.tick;
  let stepKept = true;
  if (current.quoteDecimals !== null) {
    const min = parseAtoms(current.minPrice, current.quoteDecimals);
    const step = min === null ? null : stepAtoms(min, f.stepBps);
    if (step !== null) {
      tick = formatAtoms(step, current.quoteDecimals);
      stepKept = false;
    }
  }
  const open = new Date(now.getTime() + f.openInMinutes * 60_000);
  return {
    fields: {
      kind: f.kind,
      disclosure: f.disclosure,
      supplyMode: f.supplyMode,
      ticks: f.ticks,
      tick,
      openAt: toLocalInput(open),
      closeAt: toLocalInput(new Date(open.getTime() + f.callMinutes * 60_000)),
      revealMinutes: f.revealMinutes,
      maxOrders: f.maxOrders,
    },
    stepKept,
  };
}
