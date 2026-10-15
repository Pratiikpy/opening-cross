import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_PRESETS, applyRulePreset, rulePreset, rulesFormIsEmpty } from '@opening-cross/presets/rules';
import { FLAGS, GOVERNED_GRADUATION_FLAG, buildRules } from '../src/lib/issuer-rules';

describe('the governed-graduation rule flag', () => {
  it('is the bit the program and the clients name (1 << 5)', () => {
    const client = readFileSync(new URL('../../../packages/cross-core-client/src/ext.ts', import.meta.url), 'utf8');
    expect(client).toMatch(/FLAG_GOVERNED_GRADUATION\s*=\s*1 << 5/);
    expect(GOVERNED_GRADUATION_FLAG).toBe(32);
  });
  it('is a preset that sets exactly that flag and nothing else', () => {
    const p = rulePreset('holder-vote-graduation')!;
    expect(p.needs).toEqual(['mint']);
    const form = applyRulePreset(p);
    expect(form.governedGraduation).toBe(true);
    expect(rulesFormIsEmpty(form)).toBe(false);
    expect(RULE_PRESETS.some((x) => x.id === 'holder-vote-graduation')).toBe(true);
  });
  it('is sent as bit 32 of the rules flags, alone or with the others', () => {
    const only = applyRulePreset(rulePreset('holder-vote-graduation')!);
    const built = buildRules(only, { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 } as never);
    expect(built.active).toBe(true);
    expect(built.json?.flags).toBe(32);
    const all = buildRules({ ...only, resumesHalt: true, feedsLenders: true }, { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 } as never);
    expect(all.json?.flags).toBe(32 | FLAGS.resumesHalt | FLAGS.feedsLenders);
  });
});
