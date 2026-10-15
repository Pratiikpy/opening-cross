// The one place a language model is called. The writer sees only this interface, so the gate and the retry logic are tested without a network, and a different provider is a
// different class. The Anthropic implementation reads its key from the environment (ANTHROPIC_API_KEY, HUMAN_TASKS H38); with no key it says so instead of failing late.
import Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  user: string;
  /** A JSON Schema the reply must satisfy. */
  schema: Record<string, unknown>;
  maxTokens: number;
}
export interface LlmReply {
  /** The reply text: JSON matching the schema. */
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface LlmClient {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmReply>;
}

/** The key is missing, the call was refused or cut off, or the service failed. `retryable` says whether asking again can help. */
export class LlmError extends Error {
  constructor(
    readonly code: 'NO_KEY' | 'REFUSED' | 'TRUNCATED' | 'EMPTY' | 'SERVICE',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Default model: the current Opus. Overridable per deployment (RESEARCH_MODEL) because the choice is a cost decision that belongs to the operator. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export class AnthropicLlm implements LlmClient {
  readonly name: string;
  private readonly client: Anthropic;
  constructor(private readonly opts: { apiKey?: string; model?: string; client?: Anthropic } = {}) {
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!opts.client && !key) throw new LlmError('NO_KEY', 'ANTHROPIC_API_KEY is not set; the research writer needs a key to call the model (HUMAN_TASKS H38)');
    this.client = opts.client ?? new Anthropic({ apiKey: key! });
    this.name = opts.model ?? process.env.RESEARCH_MODEL ?? DEFAULT_MODEL;
  }

  async complete(req: LlmRequest): Promise<LlmReply> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.name,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: req.schema } },
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError('NO_KEY', 'the model service rejected the API key');
      if (e instanceof Anthropic.RateLimitError) throw new LlmError('SERVICE', 'the model service is rate limiting', true);
      if (e instanceof Anthropic.APIConnectionError) throw new LlmError('SERVICE', `the model service could not be reached: ${e.message}`, true);
      if (e instanceof Anthropic.APIError) throw new LlmError('SERVICE', `the model service answered ${e.status}: ${e.message}`, (e.status ?? 0) >= 500);
      throw e;
    }
    if (res.stop_reason === 'refusal') throw new LlmError('REFUSED', 'the model declined to answer');
    if (res.stop_reason === 'max_tokens') throw new LlmError('TRUNCATED', 'the reply was cut off by the token limit', true);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text.trim()) throw new LlmError('EMPTY', 'the model returned no text', true);
    return { text, model: res.model, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
  }
}
