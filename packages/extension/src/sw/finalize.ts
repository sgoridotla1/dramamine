import { RECORDING_SCHEMA_VERSION, type Checkpoint, type Recording, type Step } from '@str/shared';
import type { RawConsole, RawNetwork, RawStep } from '../messages';

/** A navigation within this window after an action step counts as that step's consequence. */
export const NAV_CONSEQUENCE_WINDOW_MS = 1000;
/** Clicks folded into a following double-click on the same target. */
const DBLCLICK_WINDOW_MS = 600;

export interface RawCheckpoint extends Omit<Checkpoint, 'id' | 'afterStep'> {}

/** Everything captured during a recording, in arrival order, before it is assembled. */
export interface RawSession {
  id: string;
  title: string;
  startUrl: string;
  viewport: Recording['viewport'];
  browserVersion: string;
  startedAt: number;
  endedAt?: number;
  interrupted?: { reason: string };
  steps: RawStep[];
  navigations: { url: string; at: number }[];
  notes: { text: string; at: number }[];
  console: RawConsole[];
  network: RawNetwork[];
  checkpoints: RawCheckpoint[];
  redactions: number;
}

export function emptySession(init: Pick<RawSession, 'id' | 'title' | 'startUrl' | 'viewport' | 'browserVersion' | 'startedAt'>): RawSession {
  return { ...init, steps: [], navigations: [], notes: [], console: [], network: [], checkpoints: [], redactions: 0 };
}

const isAction = (s: RawStep) => s.kind !== 'initial-load' && s.kind !== 'navigate';

function sameTarget(a: RawStep, b: RawStep): boolean {
  return 'target' in a && 'target' in b && JSON.stringify(a.target.locators[0]) === JSON.stringify(b.target.locators[0]);
}

/** Replaces the click, click pair that precedes a double-click on the same target. */
function foldDoubleClicks(steps: RawStep[]): RawStep[] {
  const out: RawStep[] = [];
  for (const s of steps) {
    if (s.kind === 'dblclick') {
      let removed = 0;
      while (removed < 2) {
        const prev = out[out.length - 1];
        if (!prev || prev.kind !== 'click' || !sameTarget(prev, s) || s.at - prev.at > DBLCLICK_WINDOW_MS) break;
        out.pop();
        removed++;
      }
    }
    out.push(s);
  }
  return out;
}

/** Index of the last step that started at or before `at`. */
function stepAt(steps: Step[], at: number): number {
  let idx = 0;
  for (const s of steps) {
    if (s.at <= at) idx = s.index;
    else break;
  }
  return idx;
}

/**
 * Assembles a recording from raw captures: orders steps by time, folds double-clicks,
 * turns navigations into step consequences or standalone navigate steps, and links
 * console, network, notes and checkpoints to the step during which they happened.
 */
export function finalize(raw: RawSession): Recording {
  const actions = foldDoubleClicks(raw.steps.filter(isAction).map((s) => ({ ...s })).sort((a, b) => a.at - b.at));
  const merged: RawStep[] = [{ kind: 'initial-load', at: raw.startedAt, url: raw.startUrl }, ...actions];

  for (const nav of [...raw.navigations].sort((a, b) => a.at - b.at)) {
    // The latest step at or before the navigation.
    let prev: RawStep | undefined;
    for (const s of merged) if (s.at <= nav.at) prev = s;
    const consequence = prev && isAction(prev) && !('navigation' in prev && prev.navigation) && nav.at - prev.at <= NAV_CONSEQUENCE_WINDOW_MS;
    if (consequence && prev && 'target' in prev) {
      // Only the first navigation after an action is its consequence; later ones become navigate steps.
      (prev as { navigation?: string }).navigation = nav.url;
    } else if (prev?.kind === 'navigate' && nav.at - prev.at <= NAV_CONSEQUENCE_WINDOW_MS) {
      prev.url = nav.url;
    } else if (prev?.kind === 'initial-load' && nav.url === prev.url) {
      // Re-commit of the start page (e.g. attach during load); not a user navigation.
    } else {
      merged.push({ kind: 'navigate', at: nav.at, url: nav.url });
      merged.sort((a, b) => a.at - b.at);
    }
  }

  const steps = merged.map((s, index) => ({ ...s, index }) as Step);

  const checkpoints: Checkpoint[] = [...raw.checkpoints]
    .sort((a, b) => a.at - b.at)
    .map((c, i) => ({ ...c, id: i + 1, afterStep: stepAt(steps, c.at) }));

  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    id: raw.id,
    title: raw.title,
    startUrl: raw.startUrl,
    viewport: raw.viewport,
    browserVersion: raw.browserVersion,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    ...(raw.interrupted ? { interrupted: raw.interrupted } : {}),
    steps,
    notes: raw.notes.map((n) => ({ ...n, afterStep: stepAt(steps, n.at) })).sort((a, b) => a.at - b.at),
    console: raw.console.map((c) => ({ ...c, step: stepAt(steps, c.at) })).sort((a, b) => a.at - b.at),
    network: raw.network.map((n) => ({ ...n, step: stepAt(steps, n.at) })).sort((a, b) => a.at - b.at),
    checkpoints,
    redactions: raw.redactions,
  };
}
