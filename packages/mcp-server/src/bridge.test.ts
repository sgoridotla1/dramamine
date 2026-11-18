import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Bridge, BridgeError } from './bridge';

const ORIGIN = 'chrome-extension://testextensionid';
const bridges: Bridge[] = [];

function makeBridge(opts: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const b = new Bridge({ cwd: '/repo', extensionOrigin: ORIGIN, openUrl: async () => true, consentTimeoutMs: 2000, reconnectGraceMs: 500, ...opts });
  bridges.push(b);
  return b;
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
});

/** A fake extension: connects, says hello, and answers requests. */
function fakeExtension(port: number, token: string, opts: { origin?: string; decision?: 'approved' | 'denied'; answer?: (method: string, params: any) => unknown } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: opts.origin ?? ORIGIN });
  const messages: any[] = [];
  const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })));
  const failed = new Promise<string>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode))));
  ws.on('error', () => {});
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, decision: opts.decision ?? 'approved', extensionVersion: '0.1.0' })));
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    messages.push(msg);
    if (msg.type === 'request') {
      const result = opts.answer?.(msg.method, msg.params) ?? [];
      ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
    }
  });
  return { ws, messages, closed, failed };
}

describe('Bridge connection security', () => {
  it('listens on the loopback interface only', async () => {
    const b = makeBridge();
    await b.listen();
    expect(b.consentUrl()).toMatch(new RegExp(`^${ORIGIN}/connect\\.html\\?port=\\d+&token=[0-9a-f]{64}&cwd=%2Frepo$`));
    expect(b.consentUrl('http://localhost:5173/')).toMatch(/&appUrl=http%3A%2F%2Flocalhost%3A5173%2F$/);
  });

  it('rejects a connection from another origin', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, b.token, { origin: 'http://evil.example' });
    expect(await ext.failed).toBe('401');
    expect(b.connected).toBe(false);
  });

  it('rejects a connection with the wrong token', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, 'f'.repeat(64));
    expect((await ext.closed).code).toBe(4401);
    expect(b.connected).toBe(false);
  });

  it('accepts the extension with the session token and welcomes it with the working directory', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, b.token);
    await expect.poll(() => b.connected).toBe(true);
    await expect.poll(() => ext.messages[0]).toEqual({ type: 'welcome', cwd: '/repo' });
  });
});

describe('Bridge requests and consent', () => {
  it('opens the consent page on demand and completes the call after approval', async () => {
    let opened = '';
    const b = makeBridge({
      openUrl: async (url) => {
        opened = url;
        const port = Number(new URL(url).searchParams.get('port'));
        const token = new URL(url).searchParams.get('token')!;
        fakeExtension(port, token, { answer: () => [{ id: 'rec_1', title: 'Bug', startUrl: 'http://x', createdAt: 1, stepCount: 2, checkpointCount: 1, interrupted: false }] });
        return true;
      },
    });
    const list = await b.request('listRecordings', {});
    expect(opened).toContain('/connect.html?');
    expect(list.map((r) => r.id)).toEqual(['rec_1']);
  });

  it('fails with installation help when the extension never connects', async () => {
    const b = makeBridge({ consentTimeoutMs: 200 });
    const err = await b.request('listRecordings', {}).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.message).toContain('did not connect within');
    expect(err.message).toContain('Load unpacked');
    expect(err.message).toContain('/connect.html?');
  });

  it('includes the URL when Chrome cannot be opened', async () => {
    const b = makeBridge({ consentTimeoutMs: 100, openUrl: async () => false });
    const err = await b.request('listRecordings', {}).catch((e) => e);
    expect(err.message).toContain('Could not open Chrome automatically');
    expect(err.message).toContain(b.consentUrl());
  });

  it('fails with a declined error when the user denies', async () => {
    const b = makeBridge({
      openUrl: async (url) => {
        const u = new URL(url);
        fakeExtension(Number(u.searchParams.get('port')), u.searchParams.get('token')!, { decision: 'denied' });
        return true;
      },
    });
    const err = await b.request('listRecordings', {}).catch((e) => e);
    expect(err).toMatchObject({ code: 'declined' });
    expect(err.message).toContain('declined');
  });

  it('passes extension errors through with their code', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: b.token, decision: 'approved', extensionVersion: '0' })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'request') ws.send(JSON.stringify({ type: 'response', id: m.id, error: { code: 'busy', message: 'Another replay is running.' } }));
    });
    await expect.poll(() => b.connected).toBe(true);
    await expect(b.request('replay', { id: 'rec_1' })).rejects.toMatchObject({ code: 'busy', message: 'Another replay is running.' });
  });

  it('waits for a reconnect instead of asking for consent again', async () => {
    let opens = 0;
    const b = makeBridge({ openUrl: async () => (opens++, true) });
    const port = await b.listen();
    const first = fakeExtension(port, b.token);
    await expect.poll(() => b.connected).toBe(true);
    first.ws.close();
    await expect.poll(() => b.connected).toBe(false);
    setTimeout(() => fakeExtension(port, b.token, { answer: () => [] }), 100);
    await expect(b.request('listRecordings', {})).resolves.toEqual([]);
    expect(opens).toBe(0);
  });

  it('answers pings', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, b.token);
    await expect.poll(() => b.connected).toBe(true);
    ext.ws.send(JSON.stringify({ type: 'ping' }));
    await expect.poll(() => ext.messages.some((m) => m.type === 'pong')).toBe(true);
  });
});

describe('Bridge recordings sent by the user', () => {
  async function connected() {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, b.token);
    await expect.poll(() => b.connected).toBe(true);
    const sendRecording = (id: string) => ext.ws.send(JSON.stringify({ type: 'recording-sent', id }));
    return { b, ext, sendRecording };
  }

  it('resolves a wait when the user sends a recording, and tells the extension it is waiting', async () => {
    const { b, ext, sendRecording } = await connected();
    const next = b.nextRecording(5000);
    await expect.poll(() => ext.messages.at(-1)).toEqual({ type: 'waiting', waiting: true });
    sendRecording('rec_1');
    await expect(next).resolves.toBe('rec_1');
    await expect.poll(() => ext.messages.at(-1)).toEqual({ type: 'waiting', waiting: false });
    expect(b.sentRecordings).toEqual(['rec_1']);
  });

  it('returns a recording sent before the wait started, once', async () => {
    const { b, sendRecording } = await connected();
    sendRecording('rec_1');
    await expect.poll(() => b.sentRecordings).toEqual(['rec_1']);
    await expect(b.nextRecording(5000)).resolves.toBe('rec_1');
    await expect(b.nextRecording(100)).resolves.toBeNull();
  });

  it('gives up after the timeout or on abort', async () => {
    const { b } = await connected();
    await expect(b.nextRecording(100)).resolves.toBeNull();
    const ac = new AbortController();
    const next = b.nextRecording(5000, ac.signal);
    ac.abort();
    await expect(next).resolves.toBeNull();
  });

  it('repeats the waiting state to an extension that reconnects', async () => {
    const { b, ext } = await connected();
    const next = b.nextRecording(5000);
    ext.ws.close();
    await expect.poll(() => b.connected).toBe(false);
    const again = fakeExtension((b as any).port, b.token);
    await expect.poll(() => again.messages).toEqual([{ type: 'welcome', cwd: '/repo' }, { type: 'waiting', waiting: true }]);
    again.ws.send(JSON.stringify({ type: 'recording-sent', id: 'rec_2' }));
    await expect(next).resolves.toBe('rec_2');
  });

  it('reports whether connecting needed a new approval, and passes the app URL to the consent page', async () => {
    let opened = '';
    const b = makeBridge({
      openUrl: async (url) => {
        opened = url;
        const u = new URL(url);
        fakeExtension(Number(u.searchParams.get('port')), u.searchParams.get('token')!);
        return true;
      },
    });
    await expect(b.ensureConnected('http://localhost:5173/')).resolves.toBe(true);
    expect(new URL(opened).searchParams.get('appUrl')).toBe('http://localhost:5173/');
    await expect(b.ensureConnected('http://localhost:5173/')).resolves.toBe(false);
  });
});

describe('Bridge discovery', () => {
  it('listens on the first free port of the given range, then on a random port', async () => {
    const a = makeBridge({ ports: [47690, 47691] });
    const b = makeBridge({ ports: [47690, 47691] });
    const c = makeBridge({ ports: [47690, 47691] });
    expect(await a.listen()).toBe(47690);
    expect(await b.listen()).toBe(47691);
    const random = await c.listen();
    expect(random).not.toBe(47690);
    expect(random).not.toBe(47691);
  });

  it('tells the extension which session it is, then closes the probe', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    const reply = new Promise<any>((resolve) => ws.on('message', (d) => resolve(JSON.parse(String(d)))));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'discover' })));
    expect(await reply).toEqual({ type: 'session-info', token: b.token, cwd: '/repo', startedAt: b.startedAt, connected: false });
    expect(await closed).toBe(1000);
    expect(b.connected).toBe(false);
  });

  it('does not answer probes from web pages', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, b.token, { origin: 'http://evil.example' });
    expect(await ext.failed).toBe('401');
  });

  it('reports a recording sent while nobody waits, so the agent can be woken', async () => {
    const b = makeBridge();
    const port = await b.listen();
    const ext = fakeExtension(port, b.token);
    await expect.poll(() => b.connected).toBe(true);
    const unclaimed: unknown[] = [];
    b.onUnclaimedRecording = (r) => unclaimed.push(r);
    ext.ws.send(JSON.stringify({ type: 'recording-sent', id: 'rec_1', title: 'Cart total is $0' }));
    await expect.poll(() => unclaimed).toEqual([{ id: 'rec_1', title: 'Cart total is $0' }]);
    await expect(b.nextRecording(1000)).resolves.toBe('rec_1');
    // While a wait is pending, the wait gets it instead.
    const next = b.nextRecording(5000);
    ext.ws.send(JSON.stringify({ type: 'recording-sent', id: 'rec_2' }));
    await expect(next).resolves.toBe('rec_2');
    expect(unclaimed).toHaveLength(1);
  });
});
