import { isWebUrl } from '@str/shared';
import type { UiToSw } from '../messages';
import { folderName, h, icon, kbd, logo } from '../ui/dom';

/**
 * Consent page, opened by the MCP server with ?port=&token=&cwd=[&appUrl=]. The user approves or
 * denies the agent session. Approving opens the side panel, where they record the bug and send it,
 * and replaces this tab with the app if the agent named one. For a session that was already
 * approved (the service worker restarted), it reconnects silently and closes itself.
 */

const app = document.getElementById('app')!;
const q = new URLSearchParams(location.search);
const port = Number(q.get('port'));
const token = q.get('token') ?? '';
const cwd = q.get('cwd') ?? '';
const appUrl = q.get('appUrl') ?? '';

function call<T>(msg: UiToSw): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function closeSoon(ms: number): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  setTimeout(() => {
    if (tab?.id !== undefined) void chrome.tabs.remove(tab.id);
    else window.close();
  }, ms);
}

function sheet(...children: (Node | null)[]): HTMLElement {
  return h('main', { className: 'connect' }, h('div', { className: 'card sheet' }, ...children));
}

function done(title: string, text: string, ok: boolean): void {
  app.replaceChildren(
    sheet(h('div', { className: 'result' }, h('span', { className: ok ? 'ok-icon' : 'no-icon' }, icon(ok ? 'checkCircle' : 'xCircle')), h('h1', {}, title), h('p', { dataset: { testid: 'result' } }, text))),
  );
}

function source(iconName: 'folder' | 'globe', label: string, value: string, testid: string): HTMLElement {
  return h('div', { className: 'source' }, icon(iconName), h('div', {}, h('div', { className: 'label' }, label), h('div', { className: 'value', dataset: { testid } }, value)));
}

function render(tab: chrome.tabs.Tab | undefined): void {
  const openApp = isWebUrl(appUrl);
  const connect = h('button', { className: 'primary' }, openApp ? 'Connect and open app' : 'Connect');
  const deny = h('button', { className: 'ghost' }, 'Deny');
  connect.addEventListener('click', async () => {
    // sidePanel.open() needs the user gesture, so it runs before anything is awaited.
    if (tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    connect.disabled = deny.disabled = true;
    await call({ type: 'consent', port, token, cwd, decision: 'approved' });
    if (openApp && tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { url: appUrl });
      return;
    }
    done('Connected', `The agent in ${folderName(cwd)} is connected. Open your app in this window, record the bug in the STR side panel and click "Send to ${folderName(cwd)}". This tab will close.`, true);
    void closeSoon(4000);
  });
  deny.addEventListener('click', async () => {
    connect.disabled = deny.disabled = true;
    await call({ type: 'consent', port, token, cwd, decision: 'denied' });
    done('Declined', 'The agent was not connected. This tab will close.', false);
    void closeSoon(1500);
  });

  const folder = folderName(cwd);
  app.replaceChildren(
    sheet(
      h('div', { className: 'hero' }, logo('lg'), h('div', { className: 'stack tight' }, h('h1', {}, 'Connect a coding agent?'), h('p', { className: 'lede' }, 'An agent wants to connect to this browser, so you can show it a bug.'))),
      h('div', { className: 'sources' }, source('folder', 'Agent working in', cwd, 'cwd'), openApp ? source('globe', 'Opens your app', appUrl, 'app-url') : null),
      h(
        'ol',
        { className: 'steps' },
        h('li', {}, h('span', {}, 'Record the steps that reproduce the bug in the ', h('strong', {}, 'STR side panel'), '.')),
        h('li', {}, h('span', {}, 'Mark what is wrong with a checkpoint ', kbd('Alt', 'Shift', 'S'), '.')),
        h('li', {}, h('span', {}, 'Stop recording and click ', h('strong', {}, `Send to ${folder}`), '. The agent replays it here to reproduce the bug and verify its fix.')),
      ),
      h('div', { className: 'callout' }, icon('shield', 'sm'), h('span', {}, 'Only recordings you send are shared. They include screenshots, network bodies and console output, and go to the agent and its model provider. Passwords and auth headers are redacted when recorded.')),
      h('div', { className: 'footer' }, deny, connect),
    ),
  );
}

async function main(): Promise<void> {
  if (!port || !token) {
    done('Invalid link', 'This page must be opened by the STR MCP server.', false);
    return;
  }
  const status = await call<{ known: boolean }>({ type: 'consent-status', token });
  if (status.known) {
    done('Reconnected', `The agent in ${folderName(cwd)} is connected again. This tab will close.`, true);
    void closeSoon(800);
    return;
  }
  render(await chrome.tabs.getCurrent());
}

void main();
