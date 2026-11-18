import { ReplayParamsSchema, type Images, type Recording, type ReplayParams, type ReplayReport } from '@str/shared';
import type { CheckpointDraft, ContentMode, SwBroadcast, SwToContent, UiState } from '../messages';
import { captureViewport, cropAndScale } from './images';
import { BridgeError } from './errors';
import { RecordingSession } from './recorder';
import { runReplay } from './replay';
import * as store from './store';

/** Extension-wide state: at most one recording at a time, plus the mode of each tab's content script. */

let active: RecordingSession | null = null;
let lastError: string | undefined;
let pendingCheckpoint: { at: number; screenshot: string; css: { width: number; height: number } } | null = null;
const tabModes = new Map<number, ContentMode>();
const stateListeners = new Set<() => void>();
const sessionsProvider: { get: () => UiState['sessions'] } = { get: () => [] };
const replayFlag = { value: false };

export function setSessionsProvider(get: () => UiState['sessions']): void {
  sessionsProvider.get = get;
}

export function setReplaying(v: boolean): void {
  replayFlag.value = v;
  broadcastState();
}

export function isReplaying(): boolean {
  return replayFlag.value;
}

export function activeRecording(): RecordingSession | null {
  return active;
}

export function getState(): UiState {
  return {
    recording: active
      ? { tabId: active.tabId, title: active.raw.title, startedAt: active.raw.startedAt, steps: active.stepCount, checkpoints: active.raw.checkpoints.length, paused: active.paused }
      : null,
    replaying: replayFlag.value,
    sessions: sessionsProvider.get(),
    ...(lastError ? { lastError } : {}),
  };
}

export function onStateChanged(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

export function broadcastState(): void {
  const msg: SwBroadcast = { type: 'state-changed', state: getState() };
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no page listening */
  });
  for (const fn of stateListeners) fn();
}

export function modeForTab(tabId: number | undefined): ContentMode {
  return tabId === undefined ? 'idle' : (tabModes.get(tabId) ?? 'idle');
}

export async function setTabMode(tabId: number, mode: ContentMode): Promise<void> {
  if (mode === 'idle') tabModes.delete(tabId);
  else tabModes.set(tabId, mode);
  await sendToTab(tabId, { type: 'set-mode', mode }).catch(() => {
    /* the content script asks for its mode when it loads */
  });
}

/**
 * Makes sure the tab's top frame runs the content script. Tabs opened before the extension was
 * installed or reloaded do not have it until they reload, so it is injected; on load it asks for its mode.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToTab(tabId, { type: 'set-mode', mode: modeForTab(tabId) });
    return;
  } catch {
    /* nobody listening: inject */
  }
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
}

export function sendToTab<T = unknown>(tabId: number, msg: SwToContent): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<T>;
}

export async function startRecording(tabId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (active) {
    const tab = await chrome.tabs.get(active.tabId).catch(() => null);
    return { ok: false, error: `Already recording "${tab?.title ?? active.raw.title}" in another tab. Stop that recording first.` };
  }
  if (replayFlag.value) return { ok: false, error: 'A replay is running. Wait for it to finish.' };
  try {
    active = await RecordingSession.start(tabId, (s, reason) => {
      if (s === active) void stopRecording({ interrupted: reason });
    });
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    broadcastState();
    return { ok: false, error: lastError };
  }
  lastError = undefined;
  await setTabMode(tabId, 'record');
  await ensureContentScript(tabId).catch(() => {
    /* restricted frame; CDP still records navigation, console and network */
  });
  broadcastState();
  return { ok: true };
}

export async function stopRecording(opts: { interrupted?: string } = {}): Promise<Recording | null> {
  const s = active;
  if (!s) return null;
  active = null;
  pendingCheckpoint = null;
  await setTabMode(s.tabId, 'idle');
  const recording = await s.stop(opts);
  if (recording) await store.saveRecording(recording, s.images);
  if (opts.interrupted) lastError = `Recording stopped: ${opts.interrupted}. What was captured so far was saved.`;
  broadcastState();
  return recording;
}

export function forgetTab(tabId: number): void {
  tabModes.delete(tabId);
}

function blobId(): string {
  return `img_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Freezes the page for a checkpoint: screenshot and element snapshot are taken first, then the
 * overlay showing the frozen image is opened. Step capture stays paused until the user saves or cancels.
 */
export async function triggerCheckpoint(): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = active;
  if (!s) return { ok: false, error: 'Start a recording before taking a checkpoint.' };
  if (pendingCheckpoint) return { ok: false, error: 'A checkpoint is already open.' };
  const at = Date.now();
  s.paused = true;
  try {
    await ensureContentScript(s.tabId);
    const [shot] = await Promise.all([captureViewport(s.cdp), sendToTab<{ count: number; width: number }>(s.tabId, { type: 'checkpoint-snapshot' })]);
    pendingCheckpoint = { at, screenshot: shot.data, css: shot.css };
    await sendToTab(s.tabId, { type: 'freeze', viewport: `data:image/png;base64,${shot.data}` });
  } catch (e) {
    s.paused = false;
    pendingCheckpoint = null;
    return { ok: false, error: `Could not take a checkpoint: ${e instanceof Error ? e.message : String(e)}` };
  }
  broadcastState();
  return { ok: true };
}

export async function completeCheckpoint(draft: CheckpointDraft | undefined): Promise<void> {
  const s = active;
  const p = pendingCheckpoint;
  pendingCheckpoint = null;
  if (!s || !p) return;
  // Resume step capture before the slow image work: a click right after saving must not be lost.
  // The checkpoint's place among the steps comes from its timestamp, so the order is unaffected.
  s.paused = false;
  if (draft) {
    const regionId = blobId();
    const viewportId = blobId();
    const [region, viewport] = await Promise.all([cropAndScale(p.screenshot, draft.region, p.css), cropAndScale(p.screenshot, null, p.css)]);
    s.addCheckpoint(
      {
        at: p.at,
        target: draft.target,
        actual: draft.actual,
        ...(draft.expected ? { expected: draft.expected } : {}),
        contextOnly: !draft.expected,
        screenshots: { region: regionId, viewport: viewportId },
      },
      { [regionId]: region, [viewportId]: viewport },
    );
  }
  broadcastState();
}

export function checkpointOpen(): boolean {
  return pendingCheckpoint !== null;
}

/** Replays a stored recording. At most one replay runs at a time. */
export async function replayRecording(input: ReplayParams): Promise<{ report: ReplayReport; images: Images }> {
  const parsed = ReplayParamsSchema.safeParse(input);
  if (!parsed.success) throw new BridgeError('bad-request', `Invalid replay parameters: ${parsed.error.message}`);
  const params = parsed.data;
  if (replayFlag.value) throw new BridgeError('busy', 'Another replay is running. Wait for it to finish and try again.');
  const recording = await store.getRecording(params.id);
  if (!recording) throw new BridgeError('not-found', `No recording with id ${params.id}`);
  const known = new Set(recording.checkpoints.map((c) => c.id));
  const unknown = params.checks.filter((c) => !known.has(c.checkpoint)).map((c) => c.checkpoint);
  if (unknown.length) throw new BridgeError('bad-request', `Unknown checkpoint(s) ${[...new Set(unknown)].join(', ')}; this recording has ${recording.checkpoints.length} checkpoint(s)`);

  setReplaying(true);
  try {
    const recordedImages = await store.getImages(store.imageIds(recording));
    return await runReplay(recording, recordedImages, params);
  } finally {
    setReplaying(false);
  }
}
