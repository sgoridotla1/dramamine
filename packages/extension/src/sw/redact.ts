import type { Body } from '@str/shared';
import type { RawNetwork } from '../messages';

export const MASK = '********';
export const REDACTED = '[redacted]';
export const BODY_CAP_CHARS = 10 * 1024;

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|session/i;
const SENSITIVE_KEY = /pass(word|wd)?|token|secret|api[-_]?key|auth/i;

/** Drops sensitive headers; returns the kept headers and how many were removed. */
export function redactHeaders(headers: Record<string, string> | undefined): { headers?: Record<string, string>; count: number } {
  if (!headers) return { count: 0 };
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) count++;
    else out[k] = v;
  }
  return { headers: out, count };
}

function redactJsonValue(value: unknown, counter: { n: number }): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, counter));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k) && v !== null && typeof v !== 'object') {
        out[k] = REDACTED;
        counter.n++;
      } else {
        out[k] = redactJsonValue(v, counter);
      }
    }
    return out;
  }
  return value;
}

/** Redacts secret-looking keys in a JSON or form-encoded body. Non-JSON text is returned unchanged. */
export function redactBodyText(text: string): { text: string; count: number } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const counter = { n: 0 };
      const redacted = redactJsonValue(JSON.parse(trimmed), counter);
      return counter.n ? { text: JSON.stringify(redacted), count: counter.n } : { text, count: 0 };
    } catch {
      return { text, count: 0 };
    }
  }
  if (/^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    let count = 0;
    for (const [k] of params) {
      if (SENSITIVE_KEY.test(k)) {
        params.set(k, REDACTED);
        count++;
      }
    }
    return count ? { text: params.toString(), count } : { text, count: 0 };
  }
  return { text, count: 0 };
}

/** Caps a body at BODY_CAP_CHARS with an explicit truncation marker. Redaction runs first on the full text. */
export function capBody(text: string): Body {
  if (text.length <= BODY_CAP_CHARS) return { text };
  return { text: `${text.slice(0, BODY_CAP_CHARS)}\n...[truncated: ${text.length} chars total]`, truncated: { originalSize: text.length } };
}

/** Redacts and caps one captured request. */
export function redactNetwork(n: RawNetwork & { requestText?: string; responseText?: string }): { entry: RawNetwork; count: number } {
  let count = 0;
  const { requestText, responseText, ...entry } = n;
  const headers = redactHeaders(n.requestHeaders);
  count += headers.count;
  const out: RawNetwork = { ...entry, requestHeaders: headers.headers };
  if (requestText !== undefined) {
    const r = redactBodyText(requestText);
    count += r.count;
    out.requestBody = capBody(r.text);
  }
  if (responseText !== undefined) {
    const r = redactBodyText(responseText);
    count += r.count;
    out.responseBody = capBody(r.text);
  }
  return { entry: out, count };
}
