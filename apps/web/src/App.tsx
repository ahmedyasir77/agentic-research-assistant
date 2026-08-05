import { SHARED_CONTRACT_VERSION } from '@ara/shared';
import type { JSX } from 'react';

// Replaced in M6 by the run timeline; kept renderable so the scaffold builds.
export function App(): JSX.Element {
  return <main>Agentic Research Assistant — contract v{SHARED_CONTRACT_VERSION}</main>;
}
