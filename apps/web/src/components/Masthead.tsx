import type { JSX } from 'react';

/**
 * DESIGN.md §3 — H1 is the app title as terminal art, in Primary.
 *
 * The design asks for figlet `small` and this is not it, which is a departure
 * worth stating. figlet's small face draws its letters out of `/`, `\`, `_` and
 * backtick, and those are stroke glyphs: whether two of them join into a letter
 * depends on where the font puts a stroke inside its cell and on where the line
 * box puts the cell. Rendered in a browser it did not resolve into "ara" at any
 * size or leading — four of each were tried and screenshotted, and all of them
 * read as noise.
 *
 * Half-block elements have no such problem. `▀`, `▄` and `█` fill their cell
 * exactly, so the letterforms tile at a leading of 0.95 with nothing to align,
 * and they are single-width and non-emoji as §7 requires. Same intent — the app
 * title drawn out of characters — using the characters that survive the trip.
 *
 * Held as three literal rows rather than generated: it is the one piece of the
 * interface that is a picture, and a picture belongs in the source where a diff
 * can see it. The art is hidden from assistive tech and the real name follows it,
 * so a screen reader hears "ara — agentic research assistant" rather than
 * spelling out blocks.
 */
// prettier-ignore
const WORDMARK = [
  '▄▀▀▄ █▀▀▄ ▄▀▀▄',
  '█▀▀█ █▀█  █▀▀█',
  '█  █ █  █ █  █',
].join('\n');

export function Masthead(): JSX.Element {
  return (
    <header className="masthead">
      <h1 className="masthead__title">
        <span className="wordmark" aria-hidden="true">
          {WORDMARK}
        </span>
        <span className="masthead__name">ara — agentic research assistant</span>
      </h1>
    </header>
  );
}
