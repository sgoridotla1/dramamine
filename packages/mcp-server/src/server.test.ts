import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { sampleRecording } from '../../shared/src/test-samples';
import { createServer } from './server';

type Link = { ensureConnected?: (url?: string) => Promise<boolean>; nextRecording?: (ms: number) => Promise<string | null>; sentRecordings?: string[] };

async function connect(request: (method: string, params: any) => Promise<any>, link: Link = {}) {
  const server = createServer(Object.assign(link, { request, ensureConnected: async () => false, nextRecording: async () => null, sentRecordings: [], ...link }) as any);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('MCP server', () => {
  it('exposes the five tools with input schemas', async () => {
    const client = await connect(async () => []);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['connect_browser', 'get_recording', 'list_recordings', 'replay', 'wait_for_recording']);
    const replay = tools.find((t) => t.name === 'replay')!;
    expect(Object.keys(replay.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['id', 'checks', 'globalChecks', 'redactedValues', 'stepTimeoutMs', 'checkTimeoutMs']));
    expect(replay.inputSchema.required).toEqual(['id']);
    // The recursive locator schema (for check targets) serialises.
    expect(JSON.stringify(replay.inputSchema)).toContain('testid');
  });

  it('returns the recording log with screenshots', async () => {
    const client = await connect(async (method) => (method === 'getRecording' ? { recording: sampleRecording(), images: { blob_r1: 'aaaa', blob_v1: 'bbbb' } } : null));
    const res: any = await client.callTool({ name: 'get_recording', arguments: { id: 'rec_1' } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("getByTestId('product-card-1').getByRole('button', { name: 'Add to cart' })");
    expect(res.content.filter((c: any) => c.type === 'image').map((c: any) => c.data)).toEqual(['aaaa', 'bbbb']);
  });

  it('connect_browser opens the app on the consent page, or in a new tab once connected', async () => {
    const calls: string[] = [];
    let approved = true;
    const client = await connect(
      async (method, params) => (calls.push(`${method} ${params.url}`), { ok: true }),
      { ensureConnected: async (url) => (calls.push(`connect ${url}`), approved) },
    );
    let res: any = await client.callTool({ name: 'connect_browser', arguments: { url: 'http://localhost:5173/' } });
    expect(res.content[0].text).toContain('Connected to Chrome and opened http://localhost:5173/');
    expect(res.content[0].text).toContain('wait_for_recording');
    expect(calls).toEqual(['connect http://localhost:5173/']);
    approved = false;
    await client.callTool({ name: 'connect_browser', arguments: { url: 'http://localhost:5173/cart' } });
    expect(calls.slice(1)).toEqual(['connect http://localhost:5173/cart', 'openTab http://localhost:5173/cart']);
    res = await client.callTool({ name: 'connect_browser', arguments: { url: 'file:///etc/passwd' } });
    expect(res.isError).toBe(true);
  });

  it('wait_for_recording returns the sent recording with its screenshots', async () => {
    const client = await connect(async (method, params) => (method === 'getRecording' && params.id === 'rec_1' ? { recording: sampleRecording(), images: { blob_r1: 'aaaa', blob_v1: 'bbbb' } } : null), {
      nextRecording: async () => 'rec_1',
    });
    const res: any = await client.callTool({ name: 'wait_for_recording', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/^The user sent recording rec_1\.\n\n# STR: /);
    expect(res.content.filter((c: any) => c.type === 'image')).toHaveLength(2);
  });

  it('wait_for_recording says so when nothing was sent in time', async () => {
    let waited = 0;
    const client = await connect(async () => null, { nextRecording: async (ms) => ((waited = ms), null) });
    const res: any = await client.callTool({ name: 'wait_for_recording', arguments: { timeoutSeconds: 30 } });
    expect(waited).toBe(30_000);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('No recording was sent within 30 seconds');
  });

  it('declares a Claude Code channel and pushes an event when the user sends a recording nobody waits for', async () => {
    const link: any = { onUnclaimedRecording: null };
    const client = await connect(async () => null, link);
    expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
    const events: any[] = [];
    client.fallbackNotificationHandler = async (n) => void events.push(n);
    link.onUnclaimedRecording({ id: 'rec_1', title: 'Cart total is $0' });
    await expect.poll(() => events).toHaveLength(1);
    expect(events[0].method).toBe('notifications/claude/channel');
    expect(events[0].params.meta).toEqual({ recording_id: 'rec_1' });
    expect(events[0].params.content).toContain('"Cart total is $0" (rec_1)');
    expect(events[0].params.content).toContain('wait_for_recording');
  });

  it('returns JSON on request', async () => {
    const client = await connect(async () => ({ recording: sampleRecording(), images: {} }));
    const res: any = await client.callTool({ name: 'get_recording', arguments: { id: 'rec_1', format: 'json' } });
    expect(JSON.parse(res.content[0].text).id).toBe('rec_1');
  });

  it('reports bridge errors as tool errors', async () => {
    const { BridgeError } = await import('./bridge');
    const client = await connect(async () => {
      throw new BridgeError('declined', 'The user declined the connection in Chrome.');
    });
    const res: any = await client.callTool({ name: 'list_recordings', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('The user declined the connection in Chrome.');
  });

  it('validates replay arguments', async () => {
    const client = await connect(async () => null);
    const res: any = await client.callTool({ name: 'replay', arguments: { id: 'rec_1', checks: [{ checkpoint: 1, op: 'text-contains' }] } });
    expect(res.isError).toBe(true);
  });

  it('tells agents to replay before changing code and to verify with identical checks', async () => {
    const client = await connect(async () => []);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('Baseline replay BEFORE changing any code');
    expect(instructions).toContain('Continue only if the verdict is red');
    expect(instructions).toContain('Stop and ask the user, do not edit code');
    expect(instructions).toContain('replay again with the identical checks');
    expect(instructions).toContain('Show the compiled checks to the user');
    const { tools } = await client.listTools();
    const replay = tools.find((t) => t.name === 'replay')!;
    expect(replay.description).toMatch(/baseline replay BEFORE changing code/i);
    expect(replay.description).toContain('only on green');
  });
});
