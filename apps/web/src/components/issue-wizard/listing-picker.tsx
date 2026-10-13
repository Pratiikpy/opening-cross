'use client';

import { LAUNCH_PRESETS, LISTING_TYPES, type ListingType, type ListingTypeId, launchPreset } from '@opening-cross/presets/launch';
import { Chip, Fieldset } from './fields';

/** What the issuer is listing. Picking an available type applies its preset; a type that needs a partner says what is missing. */
export function ListingPicker({ value, onPick, presetId, onPreset, presetNote }: { value: ListingTypeId | null; onPick: (t: ListingType) => void; presetId: string | null; onPreset: (id: string) => void; presetNote: string | null }) {
  const picked = LISTING_TYPES.find((t) => t.id === value) ?? null;
  return (
    <Fieldset legend="What are you listing?" id="listing-type" note="Pick the closest type. It fills the format, the number of price levels and the length of the call, and tells you which extra steps usually apply. It never chooses your price or your supply, and every field stays editable.">
      <div role="radiogroup" aria-label="Listing type" className="grid gap-3 sm:grid-cols-2">
        {LISTING_TYPES.map((t) => {
          const on = value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`listing-${t.id}`}
              onClick={() => onPick(t)}
              className={`flex min-h-11 flex-col items-stretch justify-start rounded-lg border p-3 text-left text-sm transition-colors hover:bg-surface ${on ? 'border-ink bg-surface' : 'border-border-strong'}`}
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{t.name}</span>
                {t.availability === 'needs-partner' ? <Chip tone="info">Needs a partner</Chip> : null}
              </span>
              <span className="mt-1 block text-xs text-muted">{t.summary}</span>
            </button>
          );
        })}
      </div>
      {picked?.availability === 'needs-partner' ? (
        <div role="status" data-testid="listing-blocker" className="rounded-lg border border-border-strong bg-surface p-4 text-sm">
          <p className="font-medium">{picked.name} cannot be created from this page yet.</p>
          <p className="mt-1 text-muted">{picked.blocker}</p>
          {picked.stockTokenCheck ? <p className="mt-2 text-muted">A stock token that a licensed tokenizer has already issued can run a reopening auction today: choose “Existing token, reopening” and enter its address.</p> : null}
        </div>
      ) : null}
      {picked?.rights ? (
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">What holders get: </span>
          {picked.rights}
        </p>
      ) : null}
      <div>
        <p className="text-sm text-muted">Or pick a format directly:</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Formats">
          {LAUNCH_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p.id)}
              aria-pressed={presetId === p.id}
              data-testid={`preset-${p.id}`}
              className={`flex min-h-11 flex-col items-stretch justify-start rounded-lg border p-3 text-left text-sm transition-colors hover:bg-surface ${presetId === p.id ? 'border-ink' : 'border-border-strong'}`}
            >
              <span className="block font-medium">{p.name}</span>
              <span className="mt-1 block text-xs text-muted">{p.summary}</span>
            </button>
          ))}
        </div>
        {presetNote && presetId ? (
          <p className="mt-2 text-xs text-muted" role="status" data-testid="preset-note">
            Format applied: {launchPreset(presetId)?.name}. {presetNote} Set the supply schedule and the lowest price yourself.
          </p>
        ) : null}
      </div>
    </Fieldset>
  );
}
