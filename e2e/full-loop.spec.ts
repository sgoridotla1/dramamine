import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { addMugs, sendToAgent, startRecording, stopRecording, takeCheckpoint } from './helpers';

const SERVER = fileURLToPath(new URL('../packages/mcp-server/dist/index.js', import.meta.url));
const OPENER = fileURLToPath(new URL('./support/record-url.sh', import.meta.url));

type ToolResult = { isError?: boolean; content: ({ type: 'text'; text: string } | { type: 'image'; data: string })[] };
const text = (r: ToolResult) => (r.content[0] as { text: string }).text;

test('connect -> record -> send -> red baseline -> fix -> green verification', async ({ context, sw, fixture }, testInfo) => {
  // 1. The agent connects through the built MCP server and asks to open the app; the user approves in Chrome.
  const urlFile = testInfo.outputPath('consent-url.txt');
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...(process.env as Record<string, string>), STR_CHROME_PATH: OPENER, STR_URL_FILE: urlFile }, stderr: 'pipe' }));
  try {
    const appUrl = `${fixture.url}/products.html`;
    const connecting = client.callTool({ name: 'connect_browser', arguments: { url: appUrl } }) as Promise<ToolResult>;
    await expect.poll(() => existsSync(urlFile)).toBe(true);
    const page = await context.newPage();
    await page.goto(readFileSync(urlFile, 'utf8').trim());
    await page.getByRole('button', { name: 'Connect and open app' }).click();
    expect(text(await connecting)).toContain(`opened ${appUrl}`);
    // The consent tab became the app.
    await expect(page).toHaveURL(appUrl);
    await expect(page.getByTestId('product-card-1')).toBeVisible();

    // 2. The agent waits while the user records the bug, marks it and sends it.
    const waiting = client.callTool({ name: 'wait_for_recording', arguments: {} }) as Promise<ToolResult>;
    await startRecording(sw, page);
    await addMugs(page, fixture.url, 2);
    await page.getByRole('link', { name: 'Cart' }).click();
    await expect(page.getByTestId('cart-total')).toHaveText('$0');
    await takeCheckpoint(sw, page, page.getByTestId('cart-total'), 'Total should be $42 (2 x $21)');
    const { id } = await stopRecording(sw);
    await sendToAgent(sw, process.cwd(), id);
    const sent = await waiting;
    expect(text(sent)).toContain(`The user sent recording ${id}.`);
    expect(sent.content.filter((c) => c.type === 'image')).toHaveLength(2);

    // 3. The agent reads the recording.
    const recording = (await client.callTool({ name: 'get_recording', arguments: { id } })) as ToolResult;
    const log = text(recording);
    expect(log).toContain("getByTestId('product-card-1').getByRole('button', { name: 'Add to cart' })");
    expect(log).toContain('expected: "Total should be $42 (2 x $21)"');
    expect(log).toContain('console: warn "NaN passed to formatPrice"');
    expect(recording.content.filter((c) => c.type === 'image')).toHaveLength(2);

    // 4. It compiles the expected result into a check and runs the baseline: must be red.
    const checks = [{ checkpoint: 1, op: 'text-contains', value: '$42' }];
    fixture.state.cart = [];
    const baseline = (await client.callTool({ name: 'replay', arguments: { id, checks } }, undefined, { timeout: 120_000 })) as ToolResult;
    expect(text(baseline)).toContain('[RED]');
    expect(text(baseline)).toContain('FAIL  text-contains "$42" -> actual "$0"');

    // 5. The fix (the corrected pricing module), then 6. verification with identical checks: must be green.
    fixture.setVariant({ fixed: true });
    fixture.state.cart = [];
    const verify = (await client.callTool({ name: 'replay', arguments: { id, checks } }, undefined, { timeout: 120_000 })) as ToolResult;
    expect(text(verify)).toContain('[GREEN]');
    expect(text(verify)).toContain('PASS  text-contains "$42" -> actual "$42"');
    expect(text(verify)).toContain('replayed: "$42"');
    expect(verify.content.filter((c) => c.type === 'image').length).toBe(3);
  } finally {
    await client.close();
  }
});
