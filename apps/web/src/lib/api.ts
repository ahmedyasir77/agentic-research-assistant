import {
  AppConfigSchema,
  CreateRunResponseSchema,
  ProblemDetailsSchema,
  type AppConfig,
  type CreateRunResponse,
} from '@ara/shared';

/** Best-effort by design: a run near the end of its own life is not an error. */
export async function cancelRun(runId: string): Promise<void> {
  const response = await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
  if (!response.ok && response.status !== 409) throw await toApiError(response);
}

/**
 * The API returns exactly one error shape, so this is the one place that reads it.
 * `detail` is written for a person — the UI shows it verbatim rather than inventing
 * its own wording for a failure it does not understand.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function createRun(query: string): Promise<CreateRunResponse> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) throw await toApiError(response);
  return CreateRunResponseSchema.parse(await response.json());
}

export async function fetchAppConfig(): Promise<AppConfig> {
  const response = await fetch('/api/config');
  if (!response.ok) throw await toApiError(response);
  return AppConfigSchema.parse(await response.json());
}

async function toApiError(response: Response): Promise<ApiError> {
  const problem = ProblemDetailsSchema.safeParse(await response.json().catch(() => null));
  if (problem.success && problem.data.detail !== undefined) {
    return new ApiError(response.status, problem.data.detail);
  }
  // A response that is not problem+json means something between here and the API
  // answered — a proxy, a stale service worker — so say that rather than guessing.
  return new ApiError(
    response.status,
    `The server answered ${String(response.status)} in a shape this app does not recognise.`,
  );
}
