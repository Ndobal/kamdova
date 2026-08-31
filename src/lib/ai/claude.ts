import Anthropic from '@anthropic-ai/sdk';
import type { EnvBindings } from '../../types';
import {
  GenerationError,
  type GenerationRequest,
  type GenerationResult,
  type StructuredGenerator,
} from './provider';

/**
 * Claude-backed generator.
 *
 * Uses **strict tool use** rather than free-form JSON: the lesson template
 * defines a JSON Schema at runtime, the schema becomes a tool, and
 * `tool_choice` forces that tool. With `strict: true` the tool input is
 * guaranteed to validate against the schema, which is what lets a template be
 * data -- a fixed compiled-in schema could not describe a template the admin
 * added yesterday.
 *
 * The result is still re-validated against the template afterwards
 * (`validateContent`). Zero trust does not stop at the model boundary.
 */

/** Naira per US dollar, for turning provider USD pricing into ledger kobo. */
const DEFAULT_USD_TO_NGN = 1600;

/** claude-opus-5 list price, USD per million tokens. */
const INPUT_USD_PER_MTOK = 5;
const OUTPUT_USD_PER_MTOK = 25;

export class ClaudeGenerator implements StructuredGenerator {
  readonly provider = 'anthropic';
  readonly model: string;

  private readonly client: Anthropic;
  private readonly usdToNgn: number;

  constructor(env: EnvBindings) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new GenerationError(
        'AI generation is not configured: ANTHROPIC_API_KEY is not set.',
      );
    }
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.model = env.AI_MODEL || 'claude-opus-5';
    this.usdToNgn = Number(env.USD_TO_NGN) || DEFAULT_USD_TO_NGN;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const startedAt = Date.now();

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        thinking: { type: 'adaptive' },
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        tools: [
          {
            name: request.schemaName,
            description: request.schemaDescription,
            strict: true,
            input_schema: request.schema as Anthropic.Tool['input_schema'],
          },
        ],
        // Force the tool: the only acceptable answer is a filled-in note.
        tool_choice: { type: 'tool', name: request.schemaName },
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new GenerationError('The AI service is busy. Please try again shortly.', true);
      }
      if (error instanceof Anthropic.AuthenticationError) {
        throw new GenerationError('AI credentials are invalid.');
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new GenerationError('Could not reach the AI service.', true);
      }
      if (error instanceof Anthropic.APIError) {
        throw new GenerationError(`AI service error (${error.status}).`, error.status >= 500);
      }
      throw error;
    }

    // A safety decline arrives as HTTP 200 with stop_reason "refusal", so it
    // has to be checked before reading content.
    if (message.stop_reason === 'refusal') {
      throw new GenerationError(
        'The AI declined to generate this lesson. Try rewording the topic.',
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new GenerationError('The lesson was too long to generate. Try a narrower topic.', true);
    }

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === request.schemaName,
    );
    if (!toolUse) {
      throw new GenerationError('The AI returned no lesson content.', true);
    }

    return {
      // Strict tool use validates the shape; parsing is still done properly
      // rather than by string matching, per the tool-input escaping caveat.
      content: toolUse.input as Record<string, unknown>,
      usage: this.priceUsage(message.usage),
      model: message.model,
      provider: this.provider,
      durationMs: Date.now() - startedAt,
    };
  }

  private priceUsage(usage: Anthropic.Usage): GenerationResult['usage'] {
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

    const usd =
      (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK +
      (outputTokens / 1_000_000) * OUTPUT_USD_PER_MTOK;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      // Rounded up to whole kobo: under-charging the expense ledger by a
      // fraction on every call would understate AI cost over time.
      costKobo: Math.ceil(usd * this.usdToNgn * 100),
    };
  }
}
