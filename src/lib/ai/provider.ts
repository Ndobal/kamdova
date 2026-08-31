/**
 * The seam between TeachEasy and whichever model writes the lessons.
 *
 * Everything above this interface -- prompt assembly, schema derivation,
 * validation, persistence, cost accounting -- is provider-agnostic. Swapping
 * to Workers AI or another vendor means writing one more implementation of
 * `StructuredGenerator`, not touching the lesson pipeline.
 */

export interface GenerationRequest {
  system: string;
  prompt: string;
  /** JSON Schema the response must satisfy, derived from the lesson template. */
  schema: Record<string, unknown>;
  /** Name given to the output shape; surfaces in the provider call. */
  schemaName: string;
  schemaDescription: string;
  maxTokens?: number;
}

export interface GenerationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Cost in kobo, so it lands in the ledger in the same unit as everything else. */
  costKobo: number | null;
}

export interface GenerationResult {
  content: Record<string, unknown>;
  usage: GenerationUsage;
  model: string;
  provider: string;
  durationMs: number;
}

export interface StructuredGenerator {
  readonly provider: string;
  readonly model: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

/** Raised when the provider is reachable but produced nothing usable. */
export class GenerationError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'GenerationError';
  }
}
