# Install guide

Dramamine has two parts, and you need both:

- **The Chrome extension.** It records the bug and replays it.
- **The Claude Code plugin** (`dramamine@dramamine`). It adds the `/dramamine:record-bug` skill, the MCP server that talks to the extension, and a background monitor that wakes Claude when you send a recording.

Setup takes about five minutes.

## Requirements

- macOS or Linux. Windows is untested; the monitor that wakes Claude relies on `ps`.
- Google Chrome or Chromium 120 or newer.
- Node.js 20 or newer (`node --version`).
- Claude Code (`claude --version`), signed in.

## 1. Build

```bash
git clone <repo-url> dramamine
cd dramamine
npm install
npm run build
```

`npm run build` writes the extension to `packages/extension/dist` and the plugin's server and monitor to `plugin/server/`. Keep this folder: Chrome and Claude Code both load from it.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `packages/extension/dist` in the repo.
4. Pin **Dramamine** to the toolbar. Clicking it opens the side panel.

Chrome warns that the extension can debug your browser. That is expected: it records and replays through the Chrome DevTools Protocol, and Chrome shows a "started debugging this browser" bar while a recording or replay runs.

## 3. Install the plugin

From the repo folder:

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install dramamine@dramamine --scope user
```

`--scope user` turns it on in every repo. To turn it on for one repo only, run `/plugin install dramamine@dramamine` inside Claude Code in that repo and pick **project** (shared with your team through `.claude/settings.json`) or **local** (only you).

Restart any Claude Code sessions that were already open.

## 4. Check that it works

1. In any repo, start `claude`.
2. Run `claude mcp list` in another terminal. It should show `plugin:dramamine:str ... ✔ Connected`.
3. The Claude Code status bar shows **1 monitor**.
4. Open the Dramamine side panel in Chrome. Under **Agents** your session is listed by folder, with a **Connect** button.

If any of these is missing, see [Troubleshooting](#troubleshooting).

## 5. Try it

1. In the side panel, click **Connect** on your session.
2. Open your app, click **Start recording** and reproduce the bug.
3. Press **Alt+Shift+S**, drag over the part that is wrong and type what you expected.
4. Click **Stop recording**, then **Send to <your folder>**.

Claude wakes up, replays the recording to confirm the bug, fixes it and replays again to verify. You can also start from Claude: type `/dramamine:record-bug` and it opens Chrome for you. The [README](README.md#use) covers both flows.

To practise on a shop with a known bug, run `PORT=5180 npm start -w @str/fixture-app` and record on http://127.0.0.1:5180/products.html. The cart total shows $0 for two mugs instead of $42.

## Updating

```bash
git pull
npm install
npm run build
```

Then:

1. Reload **Dramamine** at `chrome://extensions` (the circular arrow). Chrome never picks up a new build on its own.
2. Restart your Claude Code sessions. The plugin is read straight from the repo's `plugin/` folder.
3. If `plugin/.claude-plugin/plugin.json` has a new version, also run `claude plugin update dramamine@dramamine`.

After restarting Claude, click **Connect** again in the side panel: every session gets a new token.

## Uninstalling

```bash
claude plugin uninstall dramamine@dramamine --scope user
claude plugin marketplace remove dramamine
```

Then remove **Dramamine** at `chrome://extensions`. Removing it deletes its stored recordings.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Agents** says "No agents running" | Start Claude Code after installing the plugin, and check that it is enabled in that repo (`claude mcp list` shows `plugin:dramamine:str`). Sessions are found on ports 47600-47619; `lsof -nP -iTCP:47600-47619 -sTCP:LISTEN` shows which are in use. Click the refresh icon next to **Agents** to look again. |
| The session is listed as "reconnecting", or Send says it is not connected | Claude was restarted, which gives the session a new token. Wait a few seconds for the old entry to go, then click **Connect** on the new one. |
| You clicked Send but Claude does nothing | Check that the status bar shows **1 monitor**. Monitors do not run with `claude -p`. If it is missing, type *"fix the bug I sent"*; the recording is waiting and returns at once. |
| Changes to the extension do not show up | Reload **Dramamine** at `chrome://extensions`. |
| "Could not take a checkpoint: Receiving end does not exist" | The tab was open before the extension was reloaded. Current builds repair this by themselves; if it persists, reload the tab and start a new recording. |
| "Could not attach to the tab" | Another debugger holds the tab, for example DevTools-based extensions. Close it and try again. |
| `/dramamine:record-bug` does not open Chrome | The server starts Chrome from its default location. Set `STR_CHROME_PATH` to your Chrome binary in the shell you start Claude Code from, or open the URL from the error message yourself. |
| Claude sees STR tools twice | An older setup is still registered. Remove it with `claude mcp remove str` or `claude plugin uninstall str@str`. |

**Optional: channels.** Claude Code channels are another way to wake Claude, and the plugin uses them when they are allowed. Start Claude with `claude --dangerously-load-development-channels plugin:dramamine@dramamine`. On Team and Enterprise plans an owner must turn channels on first. You don't need channels: the monitor works without them.
