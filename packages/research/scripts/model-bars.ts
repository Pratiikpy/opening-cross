// Measures the language-model half of the AI release bars (V-A) against the real model: how much of what it writes the gate has to drop, how often it falls back to the template, and
// whether any of 200 injection cases gets through. Needs ANTHROPIC_API_KEY (HUMAN_TASKS H38); without it the result says NOT RUN and exits 3. Each note is one model call, so the run
// costs money: the default is 20 notes plus 200 injection cases (about 220 calls).
//
//   ANTHROPIC_API_KEY=... pnpm exec tsx scripts/model-bars.ts [notes=20] [--no-injections]
import { buildBrief } from '@opening-cross/integrity';
import { AnthropicLlm, LlmError, runModelBars } from '../src/index.js';

const notes = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 20);
let llm: AnthropicLlm | null = null;
try {
  llm = new AnthropicLlm();
} catch (e) {
  if (!(e instanceof LlmError)) throw e;
}
const template = buildBrief({ cross: { address: 'X', kind: 'launch', state: 'Finalized', baseMint: 'B', quoteMint: 'Q', creator: 'C', ordersTotal: 40, protocolFeeBps: 30, clearing: null } });
const r = await runModelBars(llm, { tables: notes, seed: 20261016, template, injections: !process.argv.includes('--no-injections') });
console.log(JSON.stringify({ model: llm?.name ?? null, ...r }, null, 1));
process.exit(r.status === 'RUN' ? 0 : 3);
