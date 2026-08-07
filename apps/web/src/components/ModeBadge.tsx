import type { AppConfig } from '@ara/shared';
import { useEffect, useState, type JSX } from 'react';

import { fetchAppConfig } from '../lib/api.ts';
import { ICON } from './Glyphs.tsx';

/**
 * Which mode the server was deployed in, said plainly.
 *
 * A label rather than a switch, and deliberately so: `DEMO_MODE` is read from the
 * environment once at boot, so a control here could not change it — see ADR-025.
 * On stage this is the thing to point at when the wifi fails. It sits at the
 * right edge of the status bar, which is where DESIGN.md §5 puts the one piece of
 * state that is about the process rather than the work.
 */
export function ModeBadge(): JSX.Element | null {
  const [config, setConfig] = useState<AppConfig | undefined>(undefined);

  useEffect(() => {
    // A flag rather than an AbortSignal: cancelling a three-field GET buys
    // nothing, and the only thing worth avoiding is setting state after unmount.
    let live = true;
    fetchAppConfig()
      .then((loaded) => {
        if (live) setConfig(loaded);
      })
      .catch(() => {
        // The badge is context, not function. If the API cannot be reached the
        // first run will say so properly; a broken badge should not shout first.
      });
    return () => {
      live = false;
    };
  }, []);

  if (config === undefined) return null;

  const label = `${config.demoMode === 'offline' ? 'Offline demo' : 'Live'} · ${config.modelId}`;

  // The label stays one string in one text node on purpose: it is what the tests
  // match on, and splitting it across spans would leave nothing matching either.
  return (
    <span className={`mode mode--${config.demoMode}`}>
      <span className="mode__icon" aria-hidden="true">
        {config.demoMode === 'offline' ? ICON.pending : ICON.running}
      </span>
      {label}
    </span>
  );
}
