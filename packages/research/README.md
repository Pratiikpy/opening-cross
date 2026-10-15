# @opening-cross/research

The cited research-note writer (J3). A language model writes prose over a table of cited facts; a gate decides which sentences are published (ADR-0952).

| Module | Does |
|---|---|
| `writeResearchNote` | Asks the model for sentences, gates each one, asks once more for replacements, and falls back to the deterministic template brief (saying why) when the model is absent, refuses, or too few sentences pass |
| `gateSentence`, `gateDraft`, `sanitizeTable` | Per-sentence rules: cited keys exist and are stated, every number equals a cited fact, claims agree with the table, no advice or verdict, no instruction-shaped text, no unknown address. Free text in a fact never reaches the model |
| `AnthropicLlm` | The model call (`claude-opus-5-5` by default, `RESEARCH_MODEL` to change); key from `ANTHROPIC_API_KEY` |
| `buildCorpus`, `measureGate`, `measureInjections`, `runModelBars` | The AI release bar: the gate against a labelled corpus, 200 injection cases, and (with a key) the real model |

`pnpm exec tsx scripts/model-bars.ts` measures the model itself and needs a key; without one it says NOT RUN. The HTTP service is `services/integrity` (`start:brief`).
