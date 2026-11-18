import { describe, expect, it } from 'vitest';
import { BODY_CAP_CHARS, capBody, redactBodyText, redactHeaders, redactNetwork, REDACTED } from './redact';

describe('redactHeaders', () => {
  it('drops auth, cookie and token-bearing headers', () => {
    const { headers, count } = redactHeaders({
      Authorization: 'Bearer abc',
      Cookie: 'sid=1',
      'Set-Cookie': 'sid=2',
      'X-CSRF-Token': 't',
      'X-Api-Key': 'k',
      'Content-Type': 'application/json',
    });
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
    expect(count).toBe(5);
  });
});

describe('redactBodyText', () => {
  it('replaces secret JSON keys at any depth', () => {
    const { text, count } = redactBodyText(JSON.stringify({ user: { name: 'a', password: 'p' }, accessToken: 't', items: [{ apiKey: 'k', id: 1 }] }));
    expect(JSON.parse(text)).toEqual({ user: { name: 'a', password: REDACTED }, accessToken: REDACTED, items: [{ apiKey: REDACTED, id: 1 }] });
    expect(count).toBe(3);
  });

  it('redacts form-encoded secrets', () => {
    const { text, count } = redactBodyText('username=alice&password=hunter2');
    expect(text).toBe(`username=alice&password=${encodeURIComponent(REDACTED)}`);
    expect(count).toBe(1);
  });

  it('leaves non-secret and non-JSON bodies alone', () => {
    expect(redactBodyText('{"productId":1}')).toEqual({ text: '{"productId":1}', count: 0 });
    expect(redactBodyText('plain text password')).toEqual({ text: 'plain text password', count: 0 });
  });
});

describe('capBody', () => {
  it('keeps small bodies intact', () => {
    expect(capBody('abc')).toEqual({ text: 'abc' });
  });

  it('truncates at the cap with a marker and the original size', () => {
    const big = 'x'.repeat(50 * 1024);
    const body = capBody(big);
    expect(body.truncated).toEqual({ originalSize: big.length });
    expect(body.text.startsWith('x'.repeat(BODY_CAP_CHARS))).toBe(true);
    expect(body.text).toContain(`[truncated: ${big.length} chars total]`);
  });
});

describe('redactNetwork', () => {
  it('redacts before capping and counts every redaction', () => {
    const { entry, count } = redactNetwork({
      at: 1,
      method: 'POST',
      url: 'http://x/api/login',
      resourceType: 'fetch',
      requestHeaders: { authorization: 'Bearer s' },
      requestText: '{"username":"a","password":"p"}',
      responseText: '{"accessToken":"t"}',
    });
    expect(count).toBe(3);
    expect(entry.requestHeaders).toEqual({});
    expect(entry.requestBody?.text).not.toContain('"p"');
    expect(entry.responseBody?.text).toBe(`{"accessToken":"${REDACTED}"}`);
    expect(JSON.stringify(entry)).not.toMatch(/Bearer s/);
  });
});
