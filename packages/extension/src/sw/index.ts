import { renderRecordingLog } from '@str/shared';
import type { ContentReadyReply, ContentToSw, UiToSw } from '../messages';
import * as bridge from './bridge';
import * as controller from './controller';
import * as store from './store';

controller.setSessionsProvider(bridge.sessionSummaries);
// Reconnect approved agent sessions whenever the service worker starts.
void bridge.restoreSessions();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onRemoved.addListener((tabId) => controller.forgetTab(tabId));

chrome.commands.onCommand.addListener((command) => {
  if (command === 'checkpoint') void controller.triggerCheckpoint();
});

async function handleUi(msg: UiToSw): Promise<unknown> {
  switch (msg.type) {
    case 'get-state':
      return controller.getState();
    case 'start-recording':
      return controller.startRecording(msg.tabId);
    case 'stop-recording': {
      const r = await controller.stopRecording();
      return r ? { ok: true, id: r.id } : { ok: false, error: 'Not recording' };
    }
    case 'checkpoint':
      return controller.triggerCheckpoint();
    case 'list-recordings':
      return store.listRecordings();
    case 'rename-recording':
      return { ok: await store.renameRecording(msg.id, msg.title) };
    case 'delete-recording':
      await store.deleteRecording(msg.id);
      return { ok: true };
    case 'get-recording-log': {
      const r = await store.getRecording(msg.id);
      return r ? { ok: true, text: renderRecordingLog(r) } : { ok: false, error: 'Recording not found' };
    }
    case 'send-recording':
      return bridge.sendRecording(msg.token, msg.id);
    case 'discover-sessions':
      return bridge.discoverSessions();
    case 'connect-session':
      // Clicking Connect in the side panel is the user's approval, like the consent page.
      await bridge.approve(msg);
      return { ok: true };
    case 'consent-status': {
      const known = await bridge.ensureConnected(msg.token);
      return { known };
    }
    case 'consent':
      if (msg.decision === 'approved') await bridge.approve(msg);
      else await bridge.deny(msg);
      return { ok: true };
    default:
      return undefined;
  }
}

function handleContent(msg: ContentToSw, sender: chrome.runtime.MessageSender): unknown {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'content-ready':
      return { mode: sender.frameId === 0 ? controller.modeForTab(tabId) : 'idle' } satisfies ContentReadyReply;
    case 'step': {
      const rec = controller.activeRecording();
      if (rec && rec.tabId === tabId) {
        rec.addStep(msg.step);
        controller.broadcastState();
      }
      return undefined;
    }
    case 'checkpoint-done': {
      const rec = controller.activeRecording();
      if (rec && rec.tabId === tabId) void controller.completeCheckpoint(msg.draft);
      return undefined;
    }
    case 'note': {
      const rec = controller.activeRecording();
      if (rec && rec.tabId === tabId) rec.addNote(msg.text, msg.at);
      return undefined;
    }
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg: ContentToSw | UiToSw, sender, sendResponse) => {
  const fromContent = !!sender.tab && sender.url !== undefined && !sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (fromContent) {
    sendResponse(handleContent(msg as ContentToSw, sender));
    return false;
  }
  handleUi(msg as UiToSw).then(sendResponse, (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});

/** Debug and test surface, reachable from the service worker console and from e2e tests. */
Object.assign(globalThis, {
  str: {
    controller,
    store,
    bridge,
  },
});
