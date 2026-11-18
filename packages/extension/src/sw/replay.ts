import {
  computeVerdict,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  renderLocator,
  sideEffectRequests,
  type ActionStep,
  type Checkpoint,
  type CheckpointResult,
  type CheckResult,
  type ConsoleEntry,
  type Images,
  type Match,
  type NetworkEntry,
  type Recording,
  type ReplayReport,
  type ResolvedReplayParams,
  type StepResult,
} from '@str/shared';
import type { CheckpointReply, ResolveReply } from '../content/replayer';
import type { SwToContent } from '../messages';
import { CdpSession } from './cdp';
import { setTabMode } from './controller';
import { captureViewport, cropAndScale } from './images';

const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
} as const;

class StepFailure extends Error {
  constructor(
    message: string,
    readonly tried: string[] = [],
  ) {
    super(message);
  }
}

function imageId(): string {
  return `rpl_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Sends a command to the tab's content script, retrying while the page (re)loads. */
async function ask<T>(tabId: number, msg: SwToContent, waitMs: number): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as T & { reason?: string };
      if (r !== undefined && r?.reason !== 'not in replay mode') return r;
    } catch {
      /* no content script yet (navigation in progress) */
    }
    if (Date.now() >= deadline) throw new StepFailure('the page did not respond');
    await sleep(100);
  }
}

function waitForEvent(cdp: CdpSession, method: string, timeoutMs: number, filter: (p: any) => boolean = () => true): { promise: Promise<any | null>; cancel: () => void } {
  let off = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<any | null>((resolve) => {
    off = cdp.onEvent((m, p) => {
      if (m === method && filter(p)) {
        off();
        clearTimeout(timer);
        resolve(p);
      }
    });
    timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
  });
  return { promise, cancel: () => (off(), clearTimeout(timer)) };
}

/** Resolves on the next main-frame navigation; for a full navigation, after its load event. */
function waitForNavigation(cdp: CdpSession, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => (off(), resolve(false)), timeoutMs);
    const off = cdp.onEvent((m, p) => {
      if (m === 'Page.navigatedWithinDocument') {
        off();
        clearTimeout(timer);
        resolve(true);
      } else if (m === 'Page.frameNavigated' && !p.frame.parentId) {
        off();
        const load = waitForEvent(cdp, 'Page.loadEventFired', LOAD_TIMEOUT_MS);
        void load.promise.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      }
    });
  });
}

export async function runReplay(recording: Recording, recordedImages: Images, params: ResolvedReplayParams): Promise<{ report: ReplayReport; images: Images }> {
  const stepTimeout = params.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const checkTimeout = params.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const startedAt = Date.now();
  const images: Images = { ...recordedImages };
  const warnings: string[] = [];
  const sideEffects = sideEffectRequests(recording);
  if (sideEffects.length) {
    warnings.push(`The recording made ${sideEffects.length} non-GET request(s) (${sideEffects.map((r) => `${r.method} ${new URL(r.url).pathname}`).join(', ')}). Server state may differ from the recording, so results may drift.`);
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  const tabId = tab.id!;
  const cdp = await CdpSession.acquire(tabId);

  let currentStep = 0;
  const consoleSeen: ConsoleEntry[] = [];
  const networkSeen: NetworkEntry[] = [];
  const requests = new Map<string, { method: string; url: string; type: string; at: number }>();
  cdp.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails ?? {};
      const text = String(d.exception?.description ?? d.text ?? 'Uncaught exception').split('\n')[0]!;
      consoleSeen.push({ step: currentStep, at: Date.now(), level: 'exception', text });
    } else if (m === 'Runtime.consoleAPICalled' && p.type === 'error') {
      consoleSeen.push({ step: currentStep, at: Date.now(), level: 'error', text: (p.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ') });
    } else if (m === 'Network.requestWillBeSent') {
      requests.set(p.requestId, { method: p.request.method, url: p.request.url, type: p.type, at: Date.now() });
    } else if (m === 'Network.responseReceived' && p.response.status >= 400) {
      const r = requests.get(p.requestId);
      if (r && (r.type === 'Fetch' || r.type === 'XHR' || r.type === 'Document')) {
        networkSeen.push({ step: currentStep, at: r.at, method: r.method, url: r.url, resourceType: r.type === 'XHR' ? 'xhr' : 'fetch', status: p.response.status });
      }
    } else if (m === 'Network.loadingFailed' && !p.canceled) {
      const r = requests.get(p.requestId);
      if (r && (r.type === 'Fetch' || r.type === 'XHR')) networkSeen.push({ step: currentStep, at: r.at, method: r.method, url: r.url, resourceType: r.type === 'XHR' ? 'xhr' : 'fetch', errorText: p.errorText });
    }
  });

  const steps: StepResult[] = [];
  const checkpointResults: CheckpointResult[] = [];
  let failedStep: number | undefined;

  const navigate = async (url: string) => {
    const loaded = waitForEvent(cdp, 'Page.loadEventFired', LOAD_TIMEOUT_MS);
    const r = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) {
      loaded.cancel();
      throw new StepFailure(`navigation to ${url} failed: ${r.errorText}`);
    }
    if (!(await loaded.promise)) warnings.push(`${url} did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s`);
  };

  const resolve = async (step: ActionStep, actionable: boolean): Promise<ResolveReply & { ok: true }> => {
    const r = await ask<ResolveReply>(tabId, { type: 'resolve', locators: step.target.locators, timeoutMs: stepTimeout, actionable }, stepTimeout + LOAD_TIMEOUT_MS);
    if (!r.ok) throw new StepFailure(r.reason, r.tried.length ? r.tried : step.target.locators.map(renderLocator));
    return r;
  };

  const mouse = async (x: number, y: number, clicks: number) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let c = 1; c <= clicks; c++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c });
    }
  };

  const key = async (name: keyof typeof KEYS) => {
    const k = KEYS[name];
    const text = 'text' in k ? k.text : undefined;
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  };

  const typeChars = async (s: string) => {
    for (const ch of s) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  };

  const perform = async (step: ActionStep): Promise<Match> => {
    switch (step.kind) {
      case 'click':
      case 'dblclick': {
        const r = await resolve(step, true);
        await mouse(r.center.x, r.center.y, step.kind === 'dblclick' ? 2 : 1);
        return r.match;
      }
      case 'input': {
        let value = step.value;
        if (step.redacted) {
          const supplied = params.redactedValues[String(step.index)];
          if (supplied === undefined) throw new StepFailure(`the recorded value of step ${step.index} was redacted; pass it in redactedValues["${step.index}"] to replay this step`);
          value = supplied;
        }
        const r = await resolve(step, true);
        await mouse(r.center.x, r.center.y, 1);
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        if (value) await cdp.send('Input.insertText', { text: value });
        return r.match;
      }
      case 'select': {
        const r = await ask<ResolveReply>(tabId, { type: 'focus', locators: step.target.locators, timeoutMs: stepTimeout }, stepTimeout + LOAD_TIMEOUT_MS);
        if (!r.ok) throw new StepFailure(r.reason, r.tried);
        const before = await ask<{ value: string } | null>(tabId, { type: 'select-state', locators: step.target.locators }, stepTimeout);
        if (before?.value !== step.value) await typeChars(step.label);
        const after = await ask<{ value: string; label: string } | null>(tabId, { type: 'select-state', locators: step.target.locators }, stepTimeout);
        if (after?.value !== step.value) throw new StepFailure(`could not select "${step.label}" (the select shows "${after?.label ?? 'nothing'}")`);
        return r.match;
      }
      case 'key': {
        const r = await ask<ResolveReply>(tabId, { type: 'focus', locators: step.target.locators, timeoutMs: stepTimeout }, stepTimeout + LOAD_TIMEOUT_MS);
        if (!r.ok) throw new StepFailure(r.reason, r.tried);
        await key(step.key);
        return r.match;
      }
    }
  };

  const evalCheckpoint = async (cp: Checkpoint) => {
    const checks = params.checks.filter((c) => c.checkpoint === cp.id);
    const reply = await ask<CheckpointReply>(tabId, { type: 'eval-checkpoint', locators: cp.target.locators, checks, timeoutMs: checkTimeout }, checkTimeout + LOAD_TIMEOUT_MS);
    const shot = await captureViewport(cdp);
    const regionId = imageId();
    const viewportId = imageId();
    [images[regionId], images[viewportId]] = await Promise.all([cropAndScale(shot.data, reply.box ?? null, shot.css), cropAndScale(shot.data, null, shot.css)]);
    checkpointResults.push({
      checkpoint: cp.id,
      reached: true,
      ...(cp.expected ? { expected: cp.expected } : {}),
      recorded: cp.actual,
      ...(reply.facts ? { replayed: reply.facts } : {}),
      ...(reply.match ? { match: reply.match } : {}),
      ...(reply.error ? { error: `checkpoint target not found: ${reply.error}` } : {}),
      screenshots: { region: regionId, viewport: viewportId },
      recordedScreenshots: cp.screenshots,
      checks: reply.results,
    });
  };

  const checkpointsAfter = (index: number) => recording.checkpoints.filter((c) => c.afterStep === index);

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await setTabMode(tabId, 'replay');
    await navigate(recording.startUrl);
    for (const cp of checkpointsAfter(0)) await evalCheckpoint(cp);

    for (const step of recording.steps.slice(1)) {
      if (failedStep !== undefined) {
        steps.push({ index: step.index, kind: step.kind, status: 'skipped' });
        continue;
      }
      currentStep = step.index;
      const t0 = Date.now();
      try {
        if (step.kind === 'navigate' || step.kind === 'initial-load') {
          await navigate(step.url);
          steps.push({ index: step.index, kind: step.kind, status: 'ok', durationMs: Date.now() - t0 });
        } else {
          const nav = step.navigation ? waitForNavigation(cdp, stepTimeout + LOAD_TIMEOUT_MS) : null;
          const match = await perform(step);
          if (nav && !(await nav)) warnings.push(`Step ${step.index} navigated to ${step.navigation} when recorded, but no navigation happened during replay.`);
          await sleep(SETTLE_MS);
          steps.push({ index: step.index, kind: step.kind, status: 'ok', match, durationMs: Date.now() - t0 });
        }
      } catch (e) {
        failedStep = step.index;
        const err = e instanceof StepFailure ? e : new StepFailure(e instanceof Error ? e.message : String(e));
        steps.push({ index: step.index, kind: step.kind, status: 'failed', error: err.message, ...(err.tried.length ? { tried: err.tried } : {}), durationMs: Date.now() - t0 });
        continue;
      }
      for (const cp of checkpointsAfter(step.index)) await evalCheckpoint(cp);
    }
    // Let late errors (from the last step) arrive before global checks.
    await sleep(200);
  } finally {
    await setTabMode(tabId, 'idle').catch(() => {});
    await cdp.send('Network.disable').catch(() => {});
    await cdp.release();
  }

  // Checkpoints never reached because a step failed.
  for (const cp of recording.checkpoints) {
    if (checkpointResults.some((r) => r.checkpoint === cp.id)) continue;
    checkpointResults.push({
      checkpoint: cp.id,
      reached: false,
      ...(cp.expected ? { expected: cp.expected } : {}),
      recorded: cp.actual,
      recordedScreenshots: cp.screenshots,
      checks: params.checks.filter((c) => c.checkpoint === cp.id).map((check) => ({ check, status: 'not-evaluated', detail: `step ${failedStep} failed before this checkpoint` })),
    });
  }
  checkpointResults.sort((a, b) => a.checkpoint - b.checkpoint);

  const globalChecks: CheckResult[] = params.globalChecks.map((check) => {
    if (check.op === 'no-uncaught-exceptions') {
      const ex = consoleSeen.filter((c) => c.level === 'exception');
      return ex.length ? { check, status: 'fail', actual: `${ex.length} exception(s)`, detail: ex.slice(0, 3).map((e) => `step ${e.step}: ${e.text}`).join('; ') } : { check, status: 'pass', actual: 'no exceptions' };
    }
    const errors = networkSeen.filter((n) => !check.urlPattern || n.url.includes(check.urlPattern));
    return errors.length
      ? { check, status: 'fail', actual: `${errors.length} failed request(s)`, detail: errors.slice(0, 3).map((n) => `${n.method} ${n.url} -> ${n.status ?? n.errorText}`).join('; ') }
      : { check, status: 'pass', actual: 'no failed requests' };
  });

  const fallbacks = steps.filter((s) => s.match?.fallback).map((s) => s.index);
  if (fallbacks.length) warnings.push(`Step(s) ${fallbacks.join(', ')} were found by a fallback locator; the page structure changed since recording.`);

  const report: ReplayReport = {
    recordingId: recording.id,
    title: recording.title,
    startUrl: recording.startUrl,
    startedAt,
    durationMs: Date.now() - startedAt,
    warnings,
    sideEffects,
    steps,
    checkpoints: checkpointResults,
    globalChecks,
    console: consoleSeen,
    network: networkSeen,
    ...(failedStep !== undefined ? { failedStep } : {}),
    verdict: computeVerdict({ stepFailed: failedStep !== undefined, results: [...checkpointResults.flatMap((c) => c.checks), ...globalChecks] }),
  };
  return { report, images };
}
