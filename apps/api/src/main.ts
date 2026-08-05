import { EVENT_SCHEMA_VERSION } from '@ara/shared';

import { loadConfigOrExit } from './config/env.ts';

// Replaced in M5 by the Express server. Until then it proves the boot path: config
// is parsed once, a bad environment exits here, and secrets stay redacted.
const config = loadConfigOrExit(process.env);

console.log(
  JSON.stringify({
    msg: 'agentic-research-assistant api',
    demoMode: config.demoMode,
    modelId: config.llm.modelId,
    searchProvider: config.search.provider,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    config,
  }),
);
