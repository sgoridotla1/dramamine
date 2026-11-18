---
name: record-bug
description: Connect the user's Chrome to this session so they can record the steps that reproduce a bug and send the recording back, then reproduce it with a replay, fix it, and replay again to prove the fix. Use when the user says "/record-bug", "let me show you the bug", "I'll reproduce it in the browser", "record a bug", or wants to demonstrate a UI bug in a web app instead of describing it.
---

# Record a bug in Chrome and fix it

If the user already sent a recording (a `<channel source="plugin:str:str">` event says so, or they tell you), skip to step 3: call `wait_for_recording`, which returns it right away. They connected from the STR side panel themselves.

The STR Recorder extension records what the user does in Chrome (clicks, typing, console, network) and lets them mark checkpoints: what is wrong on screen and what they expected. The `str` MCP tools connect this session to the extension, wait for the user to send a recording, and replay it in their browser.

## 1. Pick the app URL

The page the user will reproduce the bug on, so it opens for them:

- If the user gave a URL, use it.
- Otherwise, if this repo has a web app and its dev server is already running, use that URL. Find the port in the `dev`/`start` script, the framework config (vite, next, astro and so on) or a quick `lsof -iTCP -sTCP:LISTEN -P` check.
- If the dev server is not running, ask the user whether to start it. Do not start long-running servers without asking.
- If unsure, skip it. The user can navigate there themselves.

## 2. Connect

Call `connect_browser` with `url` when you have one. The first time, Chrome shows a connect page with this repo's folder. The user approves there, which opens the STR side panel and the app. If the tool reports that Chrome did not connect, pass its installation help on to the user.

Then tell the user what to do, in one short message:

> Chrome is connected. In the STR side panel: **Start recording**, reproduce the bug, press **Alt+Shift+S** on the wrong part and type what you expected, then **Stop recording** and click **Send to <this folder>**.

If the user already described the bug, say what to mark in their terms (for example "mark the cart total").

## 3. Wait for the recording

Call `wait_for_recording`. It returns when the user clicks Send, with the full steps-to-reproduce log and checkpoint screenshots. If it times out, ask the user how it is going, then call it again. If they say they already sent it, call `list_recordings`.

Summarize what you received in two or three lines: the steps, and each checkpoint's actual vs expected value.

## 4. Reproduce, fix, verify (red before green)

1. **Find the code.** Locators are in Playwright syntax. Search the repo for test ids, labels and visible strings. Console errors, stack traces and failed requests are leads.
2. **Compile checks** from each checkpoint's expected result: `text-contains` for formatted values, `visible` / `hidden` / `count` for presence, `value-equals` for inputs. For crashes and failing calls, use the global checks `no-uncaught-exceptions` and `no-http-errors`. Use `judge` only when nothing deterministic fits. **Show the checks to the user** before replaying.
3. **Baseline replay before touching code.** Call `replay` with those checks. Continue only on **red**. On **green**, the checks miss the bug: stop and ask. On **error**, report the failing step and ask.
4. **Fix the code.**
5. **Verify.** Call `replay` with the identical checks. Report the bug fixed only on **green**, quoting the replayed checkpoint values. Never weaken the checks to get green without the user's agreement.

Replays run in the user's own browser session and do not reset server state. If the report warns about side effects (POST, PUT and so on), ask the user how to reset state when results drift.
