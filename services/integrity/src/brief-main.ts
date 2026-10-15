// Research-note service process. API_BASE (the Opening Cross API) is required.
//
//   ANTHROPIC_API_KEY   the model key (HUMAN_TASKS H38). Without it the service answers with the template brief and says so.
//   RESEARCH_MODEL      the model id; default claude-opus-5-5
//   PORT / HOST         default 8791 / 127.0.0.1
//   NOTE_TTL_SECS       how long a note for unchanged facts is served from memory (default 600)
//   NOTES_PER_HOUR      most model-written notes per hour (default 60)
import { AnthropicLlm, LlmError } from '@opening-cross/research';
import { createBriefService } from './brief-service.js';

const { API_BASE } = process.env;
if (!API_BASE) {
  console.error('API_BASE is required');
  process.exit(2);
}
let llm: AnthropicLlm | null = null;
try {
  llm = new AnthropicLlm();
} catch (e) {
  if (!(e instanceof LlmError)) throw e;
  console.error(JSON.stringify({ at: new Date().toISOString(), warning: e.message, serving: 'template notes only' }));
}
const svc = createBriefService({ apiBase: API_BASE.replace(/\/+$/, ''), llm, ttlSecs: Number(process.env.NOTE_TTL_SECS ?? 600), maxNotesPerHour: Number(process.env.NOTES_PER_HOUR ?? 60) });
const port = Number(process.env.PORT ?? 8791);
await svc.listen(port, process.env.HOST ?? '127.0.0.1');
console.log(JSON.stringify({ at: new Date().toISOString(), researchNotes: { port, model: llm?.name ?? null } }));
