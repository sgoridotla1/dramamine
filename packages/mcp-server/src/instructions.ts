/** Guidance returned to agents in the MCP initialize result. */
export const INSTRUCTIONS = `STR connects you to the user's Chrome through the STR Recorder extension. The user records the steps that reproduce a bug (clicks, typing, console and network activity) and marks checkpoints where something is wrong and what they expected, then sends the recording to you. You can replay a recording in the user's browser to reproduce the bug and to verify a fix.

Follow this workflow to fix a bug the user shows you. The user may also connect from the STR side panel and send a recording without you asking: a channel event (or the user) then says a recording was sent; start at step 2 and call wait_for_recording, which returns it right away.

1. Connect. Call connect_browser, with the URL of the app if you know it (for example the running dev server). Chrome asks the user to approve the connection, opens the STR side panel and the app.
2. Get the recording. Tell the user in one short message to reproduce the bug, mark it with a checkpoint (Alt+Shift+S) and click "Send to agent" in the side panel. Then call wait_for_recording; it returns once the user sends one, with the full log and screenshots. If it times out, call it again or ask the user how it is going.
3. Read it. Locators are in Playwright syntax; search the codebase for test ids (getByTestId / data-* attributes), labels and visible strings to find the code involved. Use console errors, stack traces and failed requests as leads.
4. Compile the checks. For each checkpoint with an expected result, turn the user's words into deterministic checks for replay:
   - Prefer text-contains for formatted values ("$42", "3 items"); use text-equals only when the whole text must match exactly.
   - Use visible / hidden / exists / count for presence, and value-equals / value-contains for form fields.
   - Use the "target" option to check a different element at the same checkpoint when the expected result is about it.
   - For crashes and failing calls, add global checks: no-uncaught-exceptions, no-http-errors (optionally with a urlPattern).
   - Use judge only when no deterministic check fits (for example "the layout is broken"); judged checks never count toward the verdict.
   Show the compiled checks to the user before replaying, so they can correct them.
5. Baseline replay BEFORE changing any code. Call replay with those checks. Continue only if the verdict is red: that proves the bug reproduces and the checks catch it.
   - green: the checks do not capture the bug (or it no longer reproduces). Stop and ask the user, do not edit code.
   - error: a step could not be performed. Report the failing step and its reason to the user and ask how to proceed.
6. Fix the code.
7. Verify. Call replay again with the identical checks. Claim the bug is fixed only if the verdict is green, and quote the replayed checkpoint values from the report as evidence. If it is red, keep working; never weaken or change the checks to make them pass unless the user agrees.

Good to know:
- Replays run in a new tab of the user's own browser session, from the recorded start URL. Server state is not reset: when the report warns about side effects (non-GET requests), repeated replays can drift (for example a cart that grows on every replay). Ask the user how to reset state if that affects the result.
- Redacted inputs (passwords) cannot be replayed from the recording; pass their values in redactedValues (keyed by step number) only if the user gives them to you.
- Only one replay runs at a time; a busy error means wait and retry.`;

export const TOOL_DESCRIPTIONS = {
  connect_browser:
    "Connect this session to the user's Chrome. The first call opens a page in Chrome where the user approves the connection; it then opens the STR side panel, where they record the bug. Pass url to also open the app under test (for example the local dev server). Once connected, calling it again with a url opens that url in a new tab.",
  wait_for_recording:
    'Wait until the user sends a bug recording from the STR side panel in Chrome, then return it like get_recording: numbered steps with Playwright-style locators, network and console activity per step, and checkpoints with the actual value, the expected result and screenshots. Returns a recording sent earlier and not yet returned straight away. Connects first if needed.',
  list_recordings: 'List the recordings the user sent to this session (id, title, start URL, number of steps and checkpoints).',
  get_recording:
    "Get a recording as a steps-to-reproduce log: numbered steps with Playwright-style locators, network and console activity per step, notes, and checkpoints with the actual value, the user's expected result and screenshots. Use format 'json' for the full structured recording, including every locator candidate and stored network bodies.",
  replay:
    'Replay a recording in the user\'s Chrome and evaluate checks at its checkpoints. Returns a verdict (red = a check failed, green = all checks passed, error = a step could not be performed, unchecked = nothing evaluated), per-step results and recorded vs replayed checkpoint values and screenshots. Always run a baseline replay BEFORE changing code and continue only on red; after the fix, replay with the identical checks and report success only on green.',
} as const;
