import type { EnvBindings } from '../../types';
import {
  GenerationError,
  type GenerationRequest,
  type GenerationResult,
  type StructuredGenerator,
} from './provider';

/**
 * Cloudflare Workers AI generator.
 *
 * Runs on the AI binding, so inference happens inside the same request with no
 * external API call, no third-party key to manage, and no egress.
 *
 * Structured output uses `response_format: { type: 'json_schema' }`, which is
 * how a KamDova lesson template -- a JSON Schema derived at runtime -- gets
 * filled. Only some models support it; MODELS_WITH_JSON_SCHEMA is the list, and
 * a model outside it is rejected at construction rather than failing at
 * generation time in front of a teacher.
 *
 * Two differences from the Claude path, both handled below:
 *   1. Cloudflare warns that JSON mode "may return an error if schemas are
 *      overly complex". The professional template (a four-column grid plus
 *      nested field groups) sits near that line, so a schema rejection is
 *      turned into a clear message rather than an opaque 500.
 *   2. The binding sometimes returns the object and sometimes a JSON string,
 *      depending on model. Both are accepted.
 */

/** Models that accept response_format json_schema, best-quality first. */
const MODELS_WITH_JSON_SCHEMA = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
] as const;

export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Workers AI bills in neurons, not tokens, and the neurons-per-token ratio is
 * model-specific. Rather than bake in a number that would quietly go stale,
 * the rate is configuration: kobo per 1,000 tokens, tuned from the account's
 * real neuron spend. The recorded figure is an ESTIMATE, and ai_generations
 * carries the provider and model so it can be reconciled later.
 */
const DEFAULT_KOBO_PER_1K_TOKENS = 2;

interface WorkersAiTextResult {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class WorkersAiGenerator implements StructuredGenerator {
  readonly provider = 'workers-ai';
  readonly model: string;

  private readonly ai: Ai;
  private readonly koboPer1kTokens: number;

  constructor(env: EnvBindings) {
    if (!env.AI) {
      throw new GenerationError(
        'AI generation is not configured: the Workers AI binding is missing.',
      );
    }
    this.ai = env.AI;
    this.model = env.AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
    this.koboPer1kTokens = Number(env.AI_KOBO_PER_1K_TOKENS) || DEFAULT_KOBO_PER_1K_TOKENS;

    if (!(MODELS_WITH_JSON_SCHEMA as readonly string[]).includes(this.model)) {
      // Caught here rather than at generation time: a model without JSON-schema
      // support cannot fill a template, and finding that out mid-lesson would
      // waste the teacher's time and the account's neurons.
      throw new GenerationError(
        `Model ${this.model} does not support JSON schema output. Choose one of: ${MODELS_WITH_JSON_SCHEMA.join(', ')}`,
      );
    }
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const startedAt = Date.now();

    let result: WorkersAiTextResult;
    try {
      result = (await this.ai.run(this.model as Parameters<Ai['run']>[0], {
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        // The schema goes in directly here -- unlike the OpenAI shape, it is
        // not wrapped in a { name, schema } envelope.
        response_format: { type: 'json_schema', json_schema: request.schema },
        max_tokens: request.maxTokens ?? 4096,
      } as never)) as WorkersAiTextResult;
    } catch (error) {
      throw this.translate(error);
    }

    const content = this.readContent(result);

    return {
      content,
      usage: this.priceUsage(result.usage),
      model: this.model,
      provider: this.provider,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Accepts either a parsed object or a JSON string, depending on the model. */
  private readContent(result: WorkersAiTextResult): Record<string, unknown> {
    const raw = result?.response;

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }

    if (typeof raw === 'string') {
      const text = raw.trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Smaller models occasionally wrap the object in prose or a fenced
        // block even in JSON mode. Recovering the outermost object is worth a
        // try before failing -- the result is validated against the template
        // afterwards either way, so nothing malformed can reach the database.
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try {
            return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
          } catch {
            /* fall through to the error below */
          }
        }
      }
    }

    throw new GenerationError('The AI returned no usable lesson content.', true);
  }

  private translate(error: unknown): GenerationError {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    // 7504 is Workers AI's validation failure, which is what a schema it will
    // not accept comes back as.
    if (lower.includes('7504') || lower.includes('schema') || lower.includes('validation')) {
      return new GenerationError(
        'This lesson template is too complex for the selected AI model. Simplify the template, or switch AI_PROVIDER to anthropic.',
      );
    }
    if (lower.includes('7505') || lower.includes('rate limit') || lower.includes('capacity')) {
      return new GenerationError('The AI service is busy. Please try again shortly.', true);
    }
    if (lower.includes('7506') || lower.includes('context')) {
      return new GenerationError('The lesson was too long to generate. Try a narrower topic.');
    }
    return new GenerationError(`AI service error: ${message}`.slice(0, 300), true);
  }

  private priceUsage(usage: WorkersAiTextResult['usage']): GenerationResult['usage'] {
    const inputTokens = usage?.prompt_tokens ?? null;
    const outputTokens = usage?.completion_tokens ?? null;
    const total = usage?.total_tokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: null,
      // Estimated -- see the note on DEFAULT_KOBO_PER_1K_TOKENS.
      costKobo: total > 0 ? Math.ceil((total / 1000) * this.koboPer1kTokens) : null,
    };
  }
}
