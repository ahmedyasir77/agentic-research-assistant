import { useEffect, useState, type JSX } from 'react';

/**
 * DESIGN.md §7 and §8 — the indicator set and the two things allowed to move.
 *
 * Every glyph here is single-width and none of them is an emoji, which is the
 * design's hard rule: mixed-width characters break the column alignment the whole
 * layout is measured in. They are kept in one module so that constraint is
 * enforced in one place rather than re-decided at each call site.
 */
export const ICON = {
  success: '✓',
  error: '✗',
  warning: '!',
  info: '·',
  pending: '○',
  running: '▶',
  arrow: '→',
  bullet: '·',
  selected: '▸',
} as const;

/** §4 — the section break, for the one place the page changes subject. */
export const SECTION_BREAK = '── · ──';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const THINKING_FRAMES = ['·  ', '·· ', '···', ' ··', '  ·', '   '] as const;

/**
 * The only animation on the page, and it stops for anyone who asked motion to
 * stop — in which case the first frame stands in, because a spinner that is
 * frozen still reads as "working" where a blank does not.
 *
 * The interval lives here rather than in a shared clock: a spinner is mounted
 * only while something is genuinely running, so the timer's lifetime is already
 * exactly the lifetime of the thing it describes.
 */
function useFrame(frames: readonly string[], everyMs: number): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % frames.length);
    }, everyMs);
    return () => {
      clearInterval(timer);
    };
  }, [frames.length, everyMs]);

  return frames[index] ?? frames[0] ?? '';
}

function prefersReducedMotion(): boolean {
  // Guarded rather than assumed: jsdom has matchMedia, but a non-browser render
  // target would not, and a spinner is not worth a crash.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** §8 — braille dots at 80ms, for a call that is in flight. */
export function Spinner(): JSX.Element {
  return (
    <span className="spinner" aria-hidden="true">
      {useFrame(SPINNER_FRAMES, 80)}
    </span>
  );
}

/** §8 — the slower three-dot cycle, for the agent thinking between calls. */
export function Thinking(): JSX.Element {
  return (
    <span className="spinner spinner--thinking" aria-hidden="true">
      {useFrame(THINKING_FRAMES, 300)}
    </span>
  );
}

export interface MeterProps {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}

const METER_CELLS = 20;

/**
 * §8 — `▕████████████░░░░░░░░▏ 58%`. Percentage, no ETA, because the design says
 * so and because the agent genuinely does not know how many steps it has left.
 *
 * Drawn in characters rather than as a styled div: at twenty cells it is a
 * twenty-character string, and it stays in the character grid the rest of the
 * page is aligned to. The glyphs are hidden from assistive tech, which gets the
 * `progressbar` role and the real numbers instead.
 */
export function Meter({ value, max, label }: MeterProps): JSX.Element {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * METER_CELLS);

  return (
    <span
      className="meter"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span className="meter__track" aria-hidden="true">
        ▕<span className="meter__fill">{'█'.repeat(filled)}</span>
        {'░'.repeat(METER_CELLS - filled)}▏
      </span>
      <span className="meter__pct" aria-hidden="true">
        {Math.round(ratio * 100)}%
      </span>
    </span>
  );
}
