import type { CheckpointCheck, ConsoleEntry, ElementFacts, Locator, NetworkEntry, Step, Target } from '@str/shared';

/** Messages between the service worker, content scripts and extension pages. */

export type ContentMode = 'idle' | 'record' | 'replay';

/** A step as captured by the content script, before it is numbered. */
export type RawStep = DistributiveOmit<Step, 'index'>;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type RawConsole = Omit<ConsoleEntry, 'step'>;
export type RawNetwork = Omit<NetworkEntry, 'step'>;

export interface SnapshotElement {
  id: number;
  rect: { x: number; y: number; width: number; height: number };
  text: string;
}

/** content script -> service worker */
export type ContentToSw =
  | { type: 'content-ready' }
  | { type: 'step'; step: RawStep }
  | { type: 'note'; text: string; at: number }
  | { type: 'checkpoint-done'; draft?: CheckpointDraft };

/** service worker -> content script */
export type SwToContent =
  | { type: 'set-mode'; mode: ContentMode }
  | { type: 'freeze'; viewport: string }
  | { type: 'checkpoint-snapshot' }
  | { type: 'resolve'; locators: Locator[]; timeoutMs: number; actionable: boolean }
  | { type: 'focus'; locators: Locator[]; timeoutMs: number }
  | { type: 'select-state'; locators: Locator[] }
  | { type: 'eval-checkpoint'; locators: Locator[]; checks: CheckpointCheck[]; timeoutMs: number };

export type ContentReadyReply = { mode: ContentMode };

export interface CheckpointDraft {
  target: Target;
  actual: ElementFacts;
  expected?: string;
  region: { x: number; y: number; width: number; height: number };
}

/** UI pages -> service worker */
export type UiToSw =
  | { type: 'get-state' }
  | { type: 'start-recording'; tabId: number }
  | { type: 'stop-recording' }
  | { type: 'checkpoint' }
  | { type: 'list-recordings' }
  | { type: 'rename-recording'; id: string; title: string }
  | { type: 'delete-recording'; id: string }
  | { type: 'get-recording-log'; id: string }
  | { type: 'export-recording'; id: string }
  | { type: 'send-recording'; id: string; token: string }
  | { type: 'discover-sessions' }
  | { type: 'connect-session'; port: number; token: string; cwd: string }
  | { type: 'consent-status'; token: string }
  | { type: 'consent'; port: number; token: string; cwd: string; decision: 'approved' | 'denied' };

/** An agent session as the side panel shows it. */
export interface SessionSummary {
  token: string;
  cwd: string;
  connected: boolean;
  /** The agent is waiting for a recording. */
  waiting: boolean;
  /** Ids of the recordings sent to it. */
  shared: string[];
}

export interface UiState {
  recording: null | { tabId: number; title: string; startedAt: number; steps: number; checkpoints: number; paused: boolean };
  replaying: boolean;
  sessions: SessionSummary[];
  lastError?: string;
}

/** Broadcast from the service worker when the UI state changes. */
export type SwBroadcast = { type: 'state-changed'; state: UiState };
