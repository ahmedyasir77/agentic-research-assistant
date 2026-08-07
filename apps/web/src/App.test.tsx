import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { FakeEventSource } from './test/FakeEventSource.ts';
import { makeEvent, resetSeq, scriptedRun, BUDGETS, USAGE } from './test/events.ts';

/**
 * One run, driven from the first event to a rendered citation, through the real
 * components and the real hook. The only things faked are the two things that
 * cross the network: the API and the `EventSource`.
 */
const server = setupServer(
  http.get('*/api/config', () =>
    HttpResponse.json({ demoMode: 'offline', modelId: 'fake-model', eventSchemaVersion: 1 }),
  ),
  http.post('*/api/runs', () =>
    HttpResponse.json(
      { runId: 'run_test', eventsUrl: '/api/runs/run_test/events' },
      { status: 202 },
    ),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(() => {
  FakeEventSource.reset();
  resetSeq();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});

/** Asks the question and waits for the hook to have opened its stream. */
async function ask(query = 'Why is the sky blue?'): Promise<FakeEventSource> {
  const user = userEvent.setup();
  render(<App />);

  await user.type(screen.getByRole('textbox'), query);
  await user.click(screen.getByRole('button', { name: 'Ask' }));

  await waitFor(() => {
    expect(FakeEventSource.instances).toHaveLength(1);
  });
  return FakeEventSource.latest();
}

function push(source: FakeEventSource, events: readonly Parameters<FakeEventSource['emit']>[0][]) {
  act(() => {
    for (const event of events) source.emit(event);
  });
}

describe('a run, end to end', () => {
  it('renders the timeline as it arrives and ends on a linked citation', async () => {
    const source = await ask();
    expect(source.url).toBe('/api/runs/run_test/events');

    const events = scriptedRun();
    push(source, events.slice(0, 5));

    // The timeline is built from the events, not from anything the client assumed.
    expect(screen.getByText('Step 01')).toBeInTheDocument();
    expect(screen.getByText('I will search before answering.')).toBeInTheDocument();
    expect(screen.getByText('web_search')).toBeInTheDocument();
    expect(screen.getByText(/42ms/u)).toBeInTheDocument();

    push(source, events.slice(5));

    const citation = screen.getByRole('link', { name: '[1]' });
    expect(citation).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Rayleigh_scattering');
    expect(
      screen.getByRole('link', { name: 'Rayleigh scattering — Wikipedia' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();

    // The stream is closed from this side, or EventSource would reconnect to a
    // run that has already finished.
    expect(source.readyState).toBe(2);
  });

  it('shows the counters the run actually reported', async () => {
    const source = await ask();
    push(source, scriptedRun());

    expect(screen.getByText('1 / 8')).toBeInTheDocument();
    expect(screen.getByText(/1,200 in/u)).toBeInTheDocument();
    expect(screen.getByText('$0.0135')).toBeInTheDocument();
  });

  it('expands a tool call to the raw payload that crossed the wire', async () => {
    const user = userEvent.setup();
    const source = await ask();
    push(source, scriptedRun());

    await user.click(screen.getByText('web_search'));

    expect(screen.getByText(/"maxResults": 3/u)).toBeInTheDocument();
    expect(screen.getByText(/Rayleigh_scattering/u)).toBeInTheDocument();
  });

  it('marks a citation whose url no tool returned, and keeps it', async () => {
    const source = await ask();
    push(source, scriptedRun({ citationGrounding: 'unobserved' }));

    expect(screen.getByText('Unverified')).toBeInTheDocument();
    // Kept, not deleted: showing the check catching something is the point.
    expect(screen.getByRole('link', { name: '[1]' })).toBeInTheDocument();
  });

  it('shows the passage a grounded citation was matched against', async () => {
    const source = await ask();
    push(source, scriptedRun());

    // The source's own words, not the model's copy of them — the claim being made
    // is "these words are in that page", so the page's words are what is shown.
    expect(screen.getByText('Rayleigh scattering is the', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Quoted')).toBeInTheDocument();
  });

  it('separates a quote found only in a search result from one found in the page', async () => {
    const source = await ask();
    push(source, scriptedRun({ citationGrounding: 'snippet' }));

    // Not a failure and not a clean quote either: the source is real and the words
    // are real, but nothing read the page they are attributed to.
    expect(screen.getByText('Snippet only')).toBeInTheDocument();
    expect(screen.getByText('from the search result, not the page')).toBeInTheDocument();
    expect(screen.queryByText('Quoted')).not.toBeInTheDocument();
  });

  it('shows the quote that failed, struck through, when the source never said it', async () => {
    const source = await ask();
    push(source, scriptedRun({ citationGrounding: 'unsupported' }));

    expect(screen.getByText('Quote not found')).toBeInTheDocument();
    expect(screen.getByText('not found in this source')).toBeInTheDocument();
    // The source is real and stays linked; only the words attributed to it failed.
    expect(
      screen.getByRole('link', { name: 'Rayleigh scattering — Wikipedia' }),
    ).toBeInTheDocument();
  });
});

describe('a run that stops', () => {
  it('renders a budget-exceeded run as a result, not an error', async () => {
    const source = await ask();
    push(source, [
      makeEvent({
        type: 'run.started',
        query: 'Why is the sky blue?',
        budgets: BUDGETS,
        modelId: 'fake-model',
      }),
      makeEvent({
        type: 'run.failed',
        steps: 8,
        durationMs: 60_000,
        usage: USAGE,
        estimatedCostUsd: 0.02,
        reason: 'budget_exceeded',
        message: 'Stopped after 8 steps, the configured limit.',
        partialAnswer: 'Air scatters short wavelengths more.',
        warnings: [],
      }),
    ]);

    expect(screen.getByText('Stopped at its budget')).toBeInTheDocument();
    expect(screen.getByText(/raise MAX_STEPS/u)).toBeInTheDocument();
    expect(screen.getByText('Air scatters short wavelengths more.')).toBeInTheDocument();
  });

  it('tells the user to reload when it is older than the server', async () => {
    const source = await ask();
    act(() => {
      source.emitRaw(JSON.stringify({ v: 99, type: 'something.new' }));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/older than the server/u);
    expect(source.readyState).toBe(2);
  });

  it('says what to do when the connection gives up', async () => {
    const source = await ask();
    act(() => {
      source.fail();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Ask again to retry/u);
  });

  it('shows the problem detail when the API refuses the run', async () => {
    server.use(
      http.post('*/api/runs', () =>
        HttpResponse.json(
          {
            type: '/problems/rate-limited',
            title: 'Too many runs.',
            status: 429,
            detail: 'You can start 10 runs per minute. Wait 30s and try again.',
          },
          { status: 429 },
        ),
      ),
    );

    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('textbox'), 'Why is the sky blue?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Wait 30s and try again/u);
  });
});

describe('before a run', () => {
  it('shows which mode the server is in', async () => {
    render(<App />);
    expect(await screen.findByText(/Offline demo · fake-model/u)).toBeInTheDocument();
  });

  it('offers example questions, starting with the one that is recorded', async () => {
    render(<App />);

    const chips = screen.getAllByRole('button', { name: /\?$/u });
    expect(chips[0]).toHaveTextContent('Why is the sky blue?');
    // Waited on so the config fetch settles inside act, not after the test ends.
    expect(await screen.findByText(/Offline demo/u)).toBeInTheDocument();
  });
});
