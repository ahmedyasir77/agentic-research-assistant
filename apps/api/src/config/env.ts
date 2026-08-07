import { z } from 'zod';

import { secret, type Secret } from './secret.ts';

/**
 * The only file in the codebase that reads `process.env`. It parses once at boot
 * and hands back a frozen, typed object; a misconfigured deployment fails here
 * with a readable message instead of failing later inside a request.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Offline is the default so a fresh clone runs with no keys and no network.
    DEMO_MODE: z.enum(['live', 'offline']).default('offline'),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    MODEL_ID: z.string().min(1).default('claude-opus-5'),

    SEARCH_PROVIDER: z.enum(['tavily', 'fixture']).default('fixture'),
    TAVILY_API_KEY: z.string().min(1).optional(),

    MAX_STEPS: z.coerce.number().int().min(1).max(30).default(20),
    MAX_WALL_CLOCK_MS: z.coerce.number().int().min(1_000).max(300_000).default(180_000),
    MAX_TOOL_CALLS_PER_STEP: z.coerce.number().int().min(1).max(10).default(3),
    MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(4_096),

    RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),

    // Where recorded fixtures live. Defaults to the repo's fixtures/ directory,
    // resolved from the module's own path; set explicitly in a container.
    FIXTURES_DIR: z.string().min(1).optional(),

    // Where the built React bundle lives. Defaults to apps/web/dist; when there is
    // no bundle there the API serves only JSON, which is the dev arrangement.
    WEB_DIR: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.DEMO_MODE === 'live' && env.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'required when DEMO_MODE=live — set a key, or run with DEMO_MODE=offline',
      });
    }
    if (env.SEARCH_PROVIDER === 'tavily' && env.TAVILY_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TAVILY_API_KEY'],
        message: 'required when SEARCH_PROVIDER=tavily — set a key, or use SEARCH_PROVIDER=fixture',
      });
    }
    // Offline mode is the conference-wifi insurance policy. Letting a live search
    // provider through would quietly break that promise.
    if (env.DEMO_MODE === 'offline' && env.SEARCH_PROVIDER === 'tavily') {
      ctx.addIssue({
        code: 'custom',
        path: ['SEARCH_PROVIDER'],
        message: 'must be "fixture" when DEMO_MODE=offline — offline runs make no network calls',
      });
    }
  });

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly demoMode: 'live' | 'offline';
  readonly llm: { readonly modelId: string; readonly apiKey?: Secret };
  readonly search: { readonly provider: 'tavily' | 'fixture'; readonly apiKey?: Secret };
  readonly budgets: {
    readonly maxSteps: number;
    readonly maxWallClockMs: number;
    readonly maxToolCallsPerStep: number;
    readonly maxOutputTokens: number;
  };
  readonly rateLimitPerMin: number;
  readonly fixturesDir?: string;
  readonly webDir?: string;
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid environment:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Pure and injectable, so the "bad env is rejected" behaviour is a normal unit test. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  const raw = parsed.data;
  return Object.freeze({
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    demoMode: raw.DEMO_MODE,
    llm: Object.freeze({
      modelId: raw.MODEL_ID,
      ...(raw.ANTHROPIC_API_KEY === undefined ? {} : { apiKey: secret(raw.ANTHROPIC_API_KEY) }),
    }),
    search: Object.freeze({
      provider: raw.SEARCH_PROVIDER,
      ...(raw.TAVILY_API_KEY === undefined ? {} : { apiKey: secret(raw.TAVILY_API_KEY) }),
    }),
    budgets: Object.freeze({
      maxSteps: raw.MAX_STEPS,
      maxWallClockMs: raw.MAX_WALL_CLOCK_MS,
      maxToolCallsPerStep: raw.MAX_TOOL_CALLS_PER_STEP,
      maxOutputTokens: raw.MAX_OUTPUT_TOKENS,
    }),
    rateLimitPerMin: raw.RATE_LIMIT_PER_MIN,
    ...(raw.FIXTURES_DIR === undefined ? {} : { fixturesDir: raw.FIXTURES_DIR }),
    ...(raw.WEB_DIR === undefined ? {} : { webDir: raw.WEB_DIR }),
  });
}

/**
 * Boot entry point. A config failure has to be legible on a terminal before any
 * logger exists, which is why this is one of the two places allowed to use the
 * console and to exit the process.
 */
export function loadConfigOrExit(env: NodeJS.ProcessEnv): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error('\nSee .env.example for every variable and what it does.');
      process.exit(1);
    }
    throw error;
  }
}
