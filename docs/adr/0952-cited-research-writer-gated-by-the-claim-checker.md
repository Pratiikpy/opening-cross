# ADR-0952: A language model writes the research note; a gate decides which sentences are published

Date: 2026-10-16 · Status: accepted · Implements PRODUCT_FEATURES [J3]; builds on ADR-0302 (the template brief and claim checker)

## Context
J3 promises cited AI research with no model-generated numbers, claim-level verification, and abstention on missing data. Version 0 shipped the deterministic part: templates over cited facts and a claim checker. A fluent note needs a model, and a model that is trusted with numbers, citations or tone will eventually publish a wrong figure, an invented source or a recommendation.

## Decision
`packages/research` and `services/integrity` (`brief-main.ts`). The model is trusted with wording and nothing else.
1. **Input.** A table of facts, each an integer or a plain token with a short source reference (`api:/...` or `chain:Program.Account ADDRESS .field`), built from the cites of the API's template brief. A row carrying free text anywhere (key, value, source) is dropped before the model sees it and reported as left out. No fact the protocol produces needs free text, so there is no channel for an attacker's words to reach the model.
2. **Output.** Sentences, each with the keys of the facts it states, as JSON under a schema (`output_config.format`).
3. **Gate** (`gateSentence`), per sentence, by rules a reader can audit: every cite exists and at least one is actually stated (unused cites are removed from what is published); every number, spelled-out number or percentage equals the value of a cited fact (basis-point facts may be written as bps or as the percentage) so the model never does arithmetic or rounds; a claim the parser reads must agree with the table; an enumerated fact (state, kind, backing status) may not be contradicted; an address-shaped token must be in a cited fact; no advice, forecast or valuation language, no verdict or accusation word; no instruction-shaped text, link or markup; no quantity word that is a number in disguise ("most", "half", "double"). A failing sentence is dropped, not edited.
4. **Writer.** One retry that shows the model its rejected sentences and why. If too few sentences pass (default fewer than three), the model is unavailable, refuses, is cut off, or returns something that is not the JSON asked for, the note is the deterministic template brief and says why (`fallbackReason`). The reply always states `generated`, per-sentence `origin`, the abstentions, every dropped sentence with its reason codes, the model and the token usage.
5. **Service.** `GET /v1/research/cross/:address` fetches the facts from the API, serves a note for unchanged facts from memory, caps model-written notes per hour and concurrent calls, serves the template note (and says it was limited) beyond that, and answers 502 rather than invent a note when the facts cannot be read. With no key it serves the template note and says so, from the first deploy.
6. **Model.** `claude-opus-5-5` by default through the Anthropic SDK, key from `ANTHROPIC_API_KEY` (H38), model overridable with `RESEARCH_MODEL`. Effort is `medium`.

## Alternatives considered
- **Let the model call tools or browse for sources.** Every number would then need its own verification path; a closed fact table makes the gate exact.
- **A second model as judge.** A model judging a model has the same failure modes; the rules above are deterministic.
- **Allow rounding ("about half").** Rounding is a number the facts do not state. The gate refuses it and the writer prompt tells the model so.

## Consequences
- The gate is a denylist over wording. It stops numbers, citations, advice and instructions by construction of the table and by pattern, but it cannot tell that a true, cited, number-correct sentence is misleading by omission; the abstentions list is the answer to that, and the disclosure says so. The gate-only injection test shows the limit: a benign-looking imperative quoting a cited text fact would pass, which is why free text never enters the table.
- Measured without a key: the gate against 2,636 labelled sentences (see the evidence file) and 200 injection cases against a model that obeys every instruction. NOT MEASURED: the real model's behaviour (how much it needs correcting, whether it falls back often, whether any injection reaches it). `packages/research/scripts/model-bars.ts` produces those numbers on the first run with a key and costs about 220 model calls.
- The first run of the gate against the labelled corpus found real faults, fixed here: advice phrases the first patterns missed ("consider investing", "accumulate on weakness"), a source field that accepted any words, and a claim parser that read "23 orders carry a conflict flag" as a claim about total orders and could not read "1,550,000" (both in `packages/integrity`).
