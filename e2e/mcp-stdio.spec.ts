import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { sendToAgent, startRecording, stopRecording } from './helpers';

const SERVER = fileURLToPath(new URL('../packages/mcp-server/dist/index.js', import.meta.url));
const OPENER = fileURLToPath(new URL('./support/record-url.sh', import.meta.url));

function stdioClient(env: Record<string, string> = {}) {
  const client = new Client({ name: 'stdio-check', version: '0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...(process.env as Record<string, string>), ...env }, stderr: 'pipe' });
  return { client, connect: () => client.connect(transport) };
}

test('the built MCP server starts over stdio and lists its tools', async () => {
  const { client, connect } = stdioClient();
  await connect();
  try {
    expect(client.getServerVersion()?.name).toBe('str');
    expect(client.getInstructions()).toContain('Baseline replay BEFORE changing any code');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['connect_browser', 'get_recording', 'list_recordings', 'replay', 'wait_for_recording']);
  } finally {
    await client.close();
  }
});

test('the built MCP server connects to the extension and returns the recording the user sends', async ({ context, sw, fixture }, testInfo) => {
  const urlFile = testInfo.outputPath('consent-url.txt');
  const { client, connect } = stdioClient({ STR_CHROME_PATH: OPENER, STR_URL_FILE: urlFile });
  await connect();
  try {
    const connecting = client.callTool({ name: 'connect_browser', arguments: {} });
    await expect.poll(() => existsSync(urlFile)).toBe(true);
    const consent = await context.newPage();
    await consent.goto(readFileSync(urlFile, 'utf8').trim());
    await expect(consent.getByTestId('cwd')).toHaveText(process.cwd());
    await consent.getByRole('button', { name: 'Connect' }).click();
    expect(((await connecting) as any).content[0].text).toContain('Connected to Chrome.');

    const waiting = client.callTool({ name: 'wait_for_recording', arguments: {} });
    const page = await context.newPage();
    await page.goto(`${fixture.url}/misc.html`);
    await startRecording(sw, page);
    await page.click('#fail');
    await page.waitForTimeout(150);
    const rec = await stopRecording(sw);
    await sendToAgent(sw, process.cwd(), rec.id);
    const sent: any = await waiting;
    expect(sent.isError).toBeFalsy();
    expect(sent.content[0].text).toContain(`The user sent recording ${rec.id}.`);

    const res: any = await client.callTool({ name: 'list_recordings', arguments: {} });
    expect(res.content[0].text).toContain(rec.id);

    const log: any = await client.callTool({ name: 'get_recording', arguments: { id: rec.id } });
    expect(log.content[0].text).toContain("getByRole('button', { name: 'Load report' })");
    expect(log.content[0].text).toContain('/api/fail -> 500');
  } finally {
    await client.close();
  }
});
