import type { RecordingSummary } from '@str/shared';
import type { SessionSummary, SwBroadcast, UiState, UiToSw } from '../messages';
import type { FoundSession } from '../sw/bridge';
import { isRestrictedUrl } from '../sw/cdp-url';
import { folderName, h, icon, kbd, logo, plural } from '../ui/dom';

const app = document.getElementById('app')!;

function call<T>(msg: UiToSw): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** Tests open the panel as a tab and pass the tab to record with `?tab=<id>`. */
const tabOverride = Number(new URLSearchParams(location.search).get('tab')) || null;

let state: UiState | null = null;
let recordings: RecordingSummary[] = [];
let currentTab: chrome.tabs.Tab | null = null;
let busy = false;
let message: { text: string; error?: boolean } | null = null;
const confirmingDelete = new Set<string>();
let renaming: string | null = null;
/** The recording just stopped, offered for sending right in the recorder card. */
let justSaved: string | null = null;
const logs = new Map<string, string>();
/** Agent sessions running on this machine that are not connected yet. */
let available: FoundSession[] = [];
let discovering = false;

const DISCOVER_EVERY_MS = 15_000;

async function discover(): Promise<void> {
  if (discovering) return;
  discovering = true;
  render();
  try {
    available = await call<FoundSession[]>({ type: 'discover-sessions' });
  } finally {
    discovering = false;
    render();
  }
}

function ageText(t: number): string {
  const ago = Math.round((Date.now() - t) / 60_000);
  return ago < 1 ? 'started just now' : ago < 60 ? `started ${ago} min ago` : `started ${Math.round(ago / 60)} h ago`;
}

async function loadTab(): Promise<void> {
  if (tabOverride) {
    currentTab = await chrome.tabs.get(tabOverride).catch(() => null);
  } else {
    [currentTab = null] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
}

async function refresh(): Promise<void> {
  [state, recordings] = await Promise.all([call<UiState>({ type: 'get-state' }), call<RecordingSummary[]>({ type: 'list-recordings' })]);
  await loadTab();
  render();
}

function connectedSessions(): SessionSummary[] {
  return (state?.sessions ?? []).filter((s) => s.connected);
}

function elapsed(since: number): string {
  const s = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

async function run(fn: () => Promise<{ ok: boolean; error?: string } | undefined>): Promise<void> {
  busy = true;
  message = null;
  render();
  try {
    const res = await fn();
    if (res && !res.ok) message = { text: res.error ?? 'Something went wrong', error: true };
  } catch (e) {
    message = { text: e instanceof Error ? e.message : String(e), error: true };
  }
  busy = false;
  await refresh();
}

/** One "Send to <folder>" button per connected agent. */
function sendButtons(r: RecordingSummary, prominent: boolean): HTMLElement[] {
  return connectedSessions().map((s) => {
    const sent = s.shared.includes(r.id);
    return h(
      'button',
      {
        className: prominent ? 'primary block' : sent ? 'sm ghost' : 'sm',
        disabled: busy,
        title: s.cwd,
        dataset: { testid: 'send', cwd: s.cwd },
        onclick: () =>
          void run(async () => {
            const res = await call<{ ok: boolean; error?: string }>({ type: 'send-recording', id: r.id, token: s.token });
            if (res.ok) {
              if (justSaved === r.id) justSaved = null;
              // A waiting agent gets it at once; an idle one may need a nudge unless Claude Code channels wake it.
              message = {
                text: s.waiting
                  ? `Sent "${r.title}" to the agent in ${folderName(s.cwd)}. It's on it.`
                  : `Sent "${r.title}" to the agent in ${folderName(s.cwd)}. If Claude doesn't start by itself, tell it "fix the bug I sent".`,
              };
            }
            return res;
          }),
      },
      icon('send', prominent ? '' : 'sm'),
      sent ? `Send again to ${folderName(s.cwd)}` : `Send to ${folderName(s.cwd)}`,
    );
  });
}

function countsText(steps: number, checkpoints: number): string {
  return `${plural(steps, 'step')}, ${plural(checkpoints, 'checkpoint')}`;
}

function topbar(): HTMLElement {
  const sessions = connectedSessions();
  const waiting = sessions.find((s) => s.waiting);
  const status = waiting
    ? h('span', { className: 'chip', title: waiting.cwd }, h('span', { className: 'dot brand ring' }), h('span', { className: 'label' }, `${folderName(waiting.cwd)} is waiting`))
    : sessions.length
      ? h('span', { className: 'chip', title: sessions.map((s) => s.cwd).join('\n') }, h('span', { className: 'dot ok' }), h('span', { className: 'label' }, sessions.length === 1 ? folderName(sessions[0]!.cwd) : plural(sessions.length, 'agent')))
      : h('span', { className: 'chip' }, h('span', { className: 'dot' }), h('span', { className: 'label' }, 'No agent'));
  return h('header', { className: 'topbar' }, logo(), h('h1', {}, 'Dramamine'), h('span', { className: 'spacer' }), status);
}

function recorderCard(): HTMLElement {
  const rec = state?.recording;
  if (rec) {
    return h(
      'section',
      { className: 'card recorder live', dataset: { testid: 'recorder' } },
      h(
        'div',
        { className: 'status' },
        h('span', { className: 'dot rec ring' }),
        h('span', { className: 'timer live', dataset: { testid: 'elapsed', since: String(rec.startedAt) } }, `Recording ${elapsed(rec.startedAt)}`),
        h('span', { className: 'spacer' }),
        h('span', { className: 'chip tabular', dataset: { testid: 'counts' } }, countsText(rec.steps, rec.checkpoints)),
      ),
      h('p', { className: 'muted' }, 'Reproduce the bug. When you see it, take a checkpoint and mark what is wrong.'),
      h(
        'div',
        { className: 'actions' },
        h(
          'button',
          { className: 'primary block', disabled: busy || rec.paused, onclick: () => void run(() => call({ type: 'checkpoint' })) },
          icon('target'),
          rec.paused ? 'Checkpoint open...' : 'Take checkpoint',
        ),
        h(
          'button',
          {
            className: 'block',
            disabled: busy,
            onclick: () =>
              void run(async () => {
                const res = await call<{ ok: boolean; id?: string; error?: string }>({ type: 'stop-recording' });
                if (res.ok && res.id) justSaved = res.id;
                return res;
              }),
          },
          h('span', { className: 'error' }, icon('stop', 'sm')),
          'Stop recording',
        ),
      ),
      h('div', { className: 'hint' }, 'Checkpoint shortcut', kbd('Alt', 'Shift', 'S')),
    );
  }

  const saved = justSaved ? recordings.find((r) => r.id === justSaved) : undefined;
  if (saved && connectedSessions().length) {
    return h(
      'section',
      { className: 'card recorder saved', dataset: { testid: 'recorder' } },
      h('div', { className: 'status' }, h('span', { className: 'saved-icon' }, icon('checkCircle', 'lg')), h('span', { className: 'lead' }, 'Recording saved'), h('span', { className: 'spacer' }), h('span', { className: 'chip tabular' }, countsText(saved.stepCount, saved.checkpointCount))),
      h('p', { className: 'muted' }, 'Send it to your agent. It gets the steps, console and network activity, and checkpoint screenshots.'),
      ...sendButtons(saved, true),
      h('div', { className: 'row' }, h('span', { className: 'spacer' }), h('button', { className: 'sm ghost', onclick: () => ((justSaved = null), render()) }, 'Not now'), h('span', { className: 'spacer' })),
    );
  }

  const restricted = isRestrictedUrl(currentTab?.url);
  const waiting = connectedSessions().find((s) => s.waiting);
  return h(
    'section',
    { className: 'card recorder', dataset: { testid: 'recorder' } },
    h('div', { className: 'stack tight' }, h('span', { className: 'lead' }, 'Record a bug'), h('p', { className: 'muted' }, 'Reproduce it in this tab, mark what is wrong, and send it to your coding agent.')),
    waiting
      ? h(
          'div',
          { className: 'callout brand', dataset: { testid: 'waiting' } },
          icon('bot'),
          h('span', {}, `The agent in ${folderName(waiting.cwd)} is waiting for a bug. Record it, mark it with a checkpoint, then send it.`),
        )
      : null,
    restricted
      ? h(
          'div',
          { className: 'callout warn', dataset: { testid: 'restricted' } },
          icon('lock'),
          h('span', {}, "Recording isn't available on this page. Browser pages (chrome://, the Web Store, other extensions) can't be debugged. Switch to your app's tab."),
        )
      : null,
    h(
      'button',
      {
        className: 'record block',
        disabled: busy || restricted || !!state?.replaying || !currentTab?.id,
        onclick: () => void run(() => call({ type: 'start-recording', tabId: currentTab!.id! })),
      },
      icon('record'),
      'Start recording',
    ),
    state?.replaying
      ? h('div', { className: 'callout brand' }, icon('play'), h('span', {}, 'A replay is running...'))
      : h('div', { className: 'hint' }, 'Mark a bug while recording', kbd('Alt', 'Shift', 'S')),
  );
}

function messageLine(): HTMLElement | null {
  const text = message?.text ?? state?.lastError;
  if (!text) return null;
  const ok = !!message && !message.error;
  return h('div', { className: `callout ${ok ? 'ok' : 'error'}`, dataset: { testid: 'message' } }, icon(ok ? 'checkCircle' : 'alert'), h('span', {}, text));
}

function toolButton(label: string, name: Parameters<typeof icon>[0], onclick: () => void, pressed?: boolean): HTMLElement {
  const b = h('button', { className: 'icon-btn', title: label, ariaLabel: label, onclick }, icon(name, 'sm'));
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  return b;
}

function recordingItem(r: RecordingSummary): HTMLElement {
  const li = h('li', { className: 'card rec-item', dataset: { testid: 'recording', id: r.id } });
  if (renaming === r.id) {
    const input = h('input', { type: 'text', value: r.title, ariaLabel: 'Recording title' });
    const save = () => {
      const title = input.value.trim();
      renaming = null;
      if (title && title !== r.title) void run(() => call({ type: 'rename-recording', id: r.id, title }));
      else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') {
        renaming = null;
        render();
      }
    });
    li.append(h('div', { className: 'edit' }, input, h('button', { className: 'primary', onclick: save }, 'Save')));
    queueMicrotask(() => input.select());
    return li;
  }

  const deleting = confirmingDelete.has(r.id);
  const log = logs.get(r.id);
  const sentTo = connectedSessions().filter((s) => s.shared.includes(r.id));
  li.append(
    h(
      'div',
      { className: 'head' },
      h(
        'div',
        { className: 'info' },
        h('div', { className: 'title', title: r.title }, r.title),
        h(
          'div',
          { className: 'meta' },
          h('span', { className: 'tabular' }, countsText(r.stepCount, r.checkpointCount)),
          h('span', {}, '·'),
          h('span', {}, ago(r.createdAt)),
          r.interrupted ? h('span', { className: 'badge' }, 'interrupted') : null,
        ),
      ),
      deleting
        ? h(
            'button',
            {
              className: 'sm danger',
              onclick: () => {
                confirmingDelete.delete(r.id);
                void run(() => call({ type: 'delete-recording', id: r.id }));
              },
            },
            icon('trash', 'sm'),
            'Confirm delete',
          )
        : h(
            'div',
            { className: 'tools' },
            toolButton(
              log !== undefined ? 'Hide log' : 'Log',
              'log',
              async () => {
                if (log !== undefined) logs.delete(r.id);
                else logs.set(r.id, (await call<{ ok: boolean; text?: string }>({ type: 'get-recording-log', id: r.id })).text ?? 'Not available');
                render();
              },
              log !== undefined,
            ),
            toolButton('Rename', 'pencil', () => ((renaming = r.id), render())),
            toolButton('Delete', 'trash', () => {
              confirmingDelete.add(r.id);
              render();
              setTimeout(() => confirmingDelete.delete(r.id) && render(), 4000);
            }),
          ),
    ),
    connectedSessions().length
      ? h(
          'div',
          { className: 'send-row' },
          ...sendButtons(r, false),
          sentTo.length ? h('span', { className: 'sent' }, icon('check', 'sm'), 'Sent') : null,
        )
      : '',
    log !== undefined ? h('pre', { className: 'log', dataset: { testid: 'full-log' } }, log) : '',
  );
  return li;
}

function agentRow(s: SessionSummary): HTMLElement {
  return h(
    'li',
    { className: `card agent${s.waiting ? ' waiting' : ''}`, dataset: { testid: 'agent', cwd: s.cwd } },
    h('span', { className: 'avatar' }, icon('bot')),
    h(
      'div',
      { className: 'meta' },
      h('div', { className: 'name', title: s.cwd }, folderName(s.cwd)),
      h(
        'div',
        { className: 'state' },
        h('span', { className: `dot ${s.waiting ? 'brand ring' : s.connected ? 'ok' : 'pulse'}` }),
        h('span', {}, s.waiting ? 'waiting for a recording' : s.connected ? 'connected' : 'reconnecting'),
        h('span', { className: 'faint' }, `· ${plural(s.shared.length, 'recording')} sent`),
      ),
    ),
  );
}

function availableRow(f: FoundSession): HTMLElement {
  return h(
    'li',
    { className: 'card agent available', dataset: { testid: 'available-agent', cwd: f.cwd } },
    h('span', { className: 'avatar' }, icon('bot')),
    h('div', { className: 'meta' }, h('div', { className: 'name', title: f.cwd }, folderName(f.cwd)), h('div', { className: 'state faint', title: f.cwd }, ageText(f.startedAt))),
    h(
      'button',
      {
        className: 'sm primary',
        disabled: busy,
        title: `Connect the agent in ${f.cwd}`,
        onclick: () =>
          void run(async () => {
            const res = await call<{ ok: boolean; error?: string }>({ type: 'connect-session', port: f.port, token: f.token, cwd: f.cwd });
            if (res.ok) {
              available = available.filter((a) => a.token !== f.token);
              message = { text: `Connected to the agent in ${folderName(f.cwd)}. Record the bug and send it.` };
            }
            return res;
          }),
      },
      'Connect',
    ),
  );
}

function agentsSection(): HTMLElement {
  const sessions = state?.sessions ?? [];
  const known = new Set(sessions.map((s) => s.token));
  const others = available.filter((f) => !known.has(f.token));
  const refresh = h('button', { className: 'icon-btn', title: 'Find running agents', ariaLabel: 'Find running agents', disabled: discovering, onclick: () => void discover() }, icon('refresh', `sm${discovering ? ' spin' : ''}`));
  return h(
    'section',
    {},
    h('h2', {}, 'Agents', h('span', { className: 'spacer' }), refresh),
    sessions.length || others.length
      ? h('ul', { className: 'list' }, ...sessions.map(agentRow), ...others.map(availableRow))
      : h(
          'div',
          { className: 'empty', dataset: { testid: 'no-agents' } },
          icon('bot'),
          h('strong', {}, discovering ? 'Looking for agents...' : 'No agents running'),
          h('span', { className: 'small' }, 'Start Claude Code with the dramamine plugin in your repo. It shows up here to connect.'),
        ),
  );
}

function recordingsSection(): HTMLElement {
  return h(
    'section',
    {},
    h('h2', {}, 'Recordings', recordings.length ? h('span', { className: 'count' }, String(recordings.length)) : null),
    recordings.length
      ? h('ul', { className: 'list' }, ...recordings.map(recordingItem))
      : h('div', { className: 'empty' }, icon('inbox'), h('strong', {}, 'No recordings yet.'), h('span', { className: 'small' }, 'Recordings you make show up here.')),
  );
}

function render(): void {
  // Until an agent is connected, connecting is the first step.
  const agentsFirst = !connectedSessions().length && !state?.recording;
  app.replaceChildren(
    h('main', { className: 'panel' }, topbar(), h('div', { className: 'content' }, messageLine(), ...(agentsFirst ? [agentsSection(), recorderCard()] : [recorderCard(), agentsSection()]), recordingsSection())),
  );
}

chrome.runtime.onMessage.addListener((msg: SwBroadcast) => {
  if (msg.type === 'state-changed') {
    state = msg.state;
    void refresh();
void discover();
setInterval(() => {
  if (document.visibilityState === 'visible') void discover();
}, DISCOVER_EVERY_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void discover();
});
  }
});
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') void refresh();
void discover();
setInterval(() => {
  if (document.visibilityState === 'visible') void discover();
}, DISCOVER_EVERY_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void discover();
});
});
setInterval(() => {
  const el = document.querySelector<HTMLElement>('[data-testid="elapsed"]');
  if (el) el.textContent = `Recording ${elapsed(Number(el.dataset.since))}`;
}, 1000);

void refresh();
void discover();
setInterval(() => {
  if (document.visibilityState === 'visible') void discover();
}, DISCOVER_EVERY_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void discover();
});
