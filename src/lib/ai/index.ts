import type { EnvBindings } from '../../types';
import { ClaudeGenerator } from './claude';
import type { StructuredGenerator } from './provider';
import { WorkersAiGenerator } from './workers-ai';

/**
 * Picks the generator for this deployment.
 *
 * `workers-ai` is the default: inference runs on the binding, so there is no
 * external key to hold, no egress, and no third party in the request path.
 *
 * `anthropic` stays available and is the better choice when lesson quality
 * matters more than cost or simplicity -- Claude holds a large nested schema
 * more reliably than the Workers AI models do, and the professional template
 * is a demanding one. Switching is an environment variable, not a code change,
 * which is the whole point of the StructuredGenerator seam.
 *
 * Returns null when the chosen provider is not configured, so callers can
 * refuse cleanly instead of failing mid-generation.
 */
export function createGenerator(env: EnvBindings): StructuredGenerator | null {
  const provider = (env.AI_PROVIDER || 'workers-ai').toLowerCase();

  try {
    if (provider === 'anthropic') {
      return env.ANTHROPIC_API_KEY ? new ClaudeGenerator(env) : null;
    }
    return env.AI ? new WorkersAiGenerator(env) : null;
  } catch {
    // A misconfiguration (an unsupported model, say) surfaces as "not
    // configured" here; the caller turns that into a clear 422.
    return null;
  }
}

/** Why the generator is unavailable, for an error a human can act on. */
export function generatorUnavailableReason(env: EnvBindings): string {
  const provider = (env.AI_PROVIDER || 'workers-ai').toLowerCase();

  if (provider === 'anthropic') {
    return 'AI generation is not configured: set the ANTHROPIC_API_KEY secret, or set AI_PROVIDER to "workers-ai".';
  }
  if (!env.AI) {
    return 'AI generation is not configured: the Workers AI binding is missing from wrangler.toml.';
  }
  return `AI generation is not configured: model "${env.AI_MODEL}" does not support JSON schema output.`;
}

export type { StructuredGenerator };
