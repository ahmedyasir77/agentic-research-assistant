import { llmRequestDurationSeconds, llmTokensTotal } from '../platform/metrics.ts';
import type { LlmClient } from './port.ts';

/**
 * Token and latency metrics, added as a wrapper rather than written into each
 * adapter.
 *
 * The port is the only place every model call passes through, so measuring here
 * means the fake client and the real one are instrumented identically — and the
 * offline demo produces a populated `/metrics` page without anyone faking numbers.
 */
export function withLlmMetrics(client: LlmClient): LlmClient {
  return {
    modelId: client.modelId,
    complete: async (request) => {
      const stopTimer = llmRequestDurationSeconds.startTimer({ model: client.modelId });
      try {
        const response = await client.complete(request);
        stopTimer({ outcome: 'ok' });
        llmTokensTotal.inc({ type: 'input' }, response.usage.inputTokens);
        llmTokensTotal.inc({ type: 'output' }, response.usage.outputTokens);
        return response;
      } catch (error) {
        // A failed call still took time and still cost the caller latency, so it
        // is observed too — a p95 that silently drops errors is a lie.
        stopTimer({ outcome: 'error' });
        throw error;
      }
    },
  };
}
