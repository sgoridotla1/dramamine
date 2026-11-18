<p align="center">
  <img src="assets/dramamine.png" width="200" alt="dramamine logo: a girl in a winged headset with a pill">
</p>

# STR Recorder

Show your coding agent a bug instead of describing it. Type `/dramamine:record-bug` in Claude Code: the agent connects to your Chrome, you record the steps to reproduce (STR) the bug and mark exactly what is wrong, and click **Send**. The agent reproduces it, fixes it in your repo, and replays the same steps to prove the fix works.

```
 Chrome                                   your machine
+--------------------------------+       +-------------------------------------+
| STR Recorder extension         |       | Claude Code (in your repo)          |
|  - records steps, console,     |  ws   |   |  MCP (stdio)                    |
|    network, locators           |<----->|   v                                 |
|  - checkpoints: screenshot +   | local |  dramamine plugin:                  |
|    "expected result"           | host  |   /dramamine:record-bug skill       |
|  - "Send to agent"             |       |   + MCP server: connect_browser,    |
|  - replays steps, runs checks  |       |   wait_for_recording, replay ...    |
+--------------------------------+       +-------------------------------------+
```

The agent follows a red-before-green loop. It turns your "expected" text into checks, replays the recording and requires the checks to **fail** on the current code, fixes the code, then replays with the **same** checks and reports success only when they pass.

## Install

See **[INSTALL.md](INSTALL.md)** for requirements, checks, updating and troubleshooting. In short:

```bash
npm install && npm run build
claude plugin marketplace add "$(pwd)"
claude plugin install dramamine@dramamine --scope user
```

Then load `packages/extension/dist` as an unpacked extension at `chrome://extensions` (Developer mode on), and restart Claude Code.

## Use

There are two ways to start: from the browser, or from Claude.

### From the browser (fastest)

1. Start Claude Code in your repository with the STR channel, so a recording you send wakes the agent:

   ```bash
   claude --dangerously-load-development-channels plugin:dramamine@dramamine
   ```

   Plain `claude` works too; then type something like *"fix the bug I sent"* after sending.
2. Open the STR side panel in Chrome. Under **Agents** it lists the Claude Code sessions running on your machine. Click **Connect** on your repo's session.
3. Record the bug, take a checkpoint (**Alt+Shift+S**), stop, and click **Send to <your repo folder>**. With the channel on, Claude starts on it right away: it shows the checks it compiled, replays the recording, fixes the code and replays again to verify.

### From Claude

1. In your repository, start Claude Code and type `/dramamine:record-bug`, optionally with what is wrong (*"/dramamine:record-bug the cart total is $0"*). Saying *"let me show you the bug in the browser"* works too.
2. Chrome opens a connect page showing the agent's working directory. Click **Connect**. This opens the STR side panel and, if the agent found your app's URL (for example a running dev server), the app.
3. Click **Start recording** in the side panel and reproduce the bug.
4. When you see it, press **Alt+Shift+S** or click **Take checkpoint**. The page freezes. Drag around the part that is wrong, check the **Actual** value and type what you **Expected** (for example *"Total should be $42 (2 x $21)"*). Press Enter. You can take several checkpoints. One without an expected value is kept as context only.
5. Click **Stop recording**, then **Send to <your repo folder>**. The side panel shows when the agent is waiting. You can also send any earlier recording from the list, and view its full log first with **Log**.
6. Claude shows you the checks it compiled, replays the recording (a new tab opens, and you can watch), fixes the code, and replays again to verify.

## Permissions and privacy

- **`debugger` permission.** Recording and replay use the Chrome DevTools Protocol, which gives trusted input, console output with stack traces, and network bodies. Chrome shows a strong warning at install time and a *"STR Recorder started debugging this browser"* bar while it is attached. DevTools can stay open while you record.
- **What is captured:** your clicks, typing, selections and Enter/Escape/Tab keys, with locators for each element; console errors and warnings; uncaught exceptions; `fetch`/XHR requests with status, timing and bodies up to 10 KB; navigation; and checkpoint screenshots. Images, scripts, styles and fonts are not captured.
- **Redaction before anything is stored:** password fields are masked (the value never leaves the page), `Authorization`, `Cookie`, `Set-Cookie` and token-like headers are dropped, and JSON or form fields named like `password`, `token`, `secret`, `apiKey` or `auth` are replaced with `[redacted]`.
- **Where data goes:** recordings stay in the extension's local storage until you click **Send**. Sent recordings go to that agent, and therefore to its model provider. Open **Log** on a recording to check it for personal data in page text before sending.
- The MCP server listens only on `127.0.0.1`, on a random port. It accepts only the extension's origin presenting a per-session token, and each agent session sees only the recordings you sent to it.

## Known limitations

- Channels are a Claude Code research preview. On a Team or Enterprise plan an owner must turn them on (Organization settings > Claude Code > Channels); otherwise the event is dropped silently and you nudge the agent yourself after sending. The side panel finds sessions on ports 47600-47619; a session that cannot get one of them can still be connected with the skill.
- One tab per recording. Popups, new tabs, file uploads and drag and drop are noted in the log but not recorded. Hover-only menus and cross-origin iframes are not supported.
- Replay runs in your current browser session from the recorded start URL and does **not** reset server state. When a recording changes data (POST, PUT and so on), repeated replays can drift, and the report warns about it.
- Redacted inputs (passwords) can only be replayed when you give their values to the agent.
- Native `<select>` options are chosen by typing their label (typeahead).
- Restricted pages (`chrome://`, the Web Store, other extensions) cannot be recorded.
- A connection lasts as long as the agent session and the browser. After restarting either one, run the skill again to reconnect.

## Troubleshooting

See [INSTALL.md](INSTALL.md#troubleshooting).

## Development

```
packages/
  shared/       recording, locator, check and report models; bridge protocol; log renderers
  extension/    MV3 extension: service worker, content script, side panel, connect page
  mcp-server/   stdio MCP server and WebSocket bridge
  fixture-app/  small shop with deliberate bugs, for e2e tests and trying things out
plugin/         Claude Code plugin: record-bug skill, MCP config, built server (plugin/server/)
.claude-plugin/ marketplace that lists the plugin
e2e/            Playwright tests that drive Chromium with the unpacked extension
```

```bash
npm run build       # extension -> packages/extension/dist, server -> packages/mcp-server/dist and plugin/server
npm test            # unit tests (Vitest)
npm run test:e2e    # builds, then runs the browser tests (Playwright Chromium)
npm run typecheck
npm start -w @str/fixture-app   # fixture shop on http://127.0.0.1:5173
```

To try the full loop by hand, run the fixture shop and type `/dramamine:record-bug` in Claude Code started in this repository. When Chrome opens the shop, record: add two **Coffee mugs** to the cart, open **Cart**, take a checkpoint on the **$0** total with the expectation *"Total should be $42"*, stop and send. The bug is in `packages/fixture-app/public/pricing.js`.
