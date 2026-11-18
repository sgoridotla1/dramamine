// @vitest-environment happy-dom
import type { CheckpointCheck, Locator } from '@str/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateCheck, evaluateCheckpoint } from './replayer';

const total: Locator = { kind: 'testid', attr: 'data-testid', value: 'total' };
const check = (op: CheckpointCheck['op'], value?: string | number, target?: Locator): CheckpointCheck => ({ checkpoint: 1, op, ...(value !== undefined ? { value } : {}), ...(target ? { target } : {}) });

function el(): Element | null {
  return document.querySelector('[data-testid="total"]');
}

beforeEach(() => {
  document.body.innerHTML = `
    <table><tr><th>Total</th><td data-testid="total">  Total:
      $42 </td></tr></table>
    <input data-testid="qty" value="2">
    <ul><li class="i">a</li><li class="i">b</li><li class="i" style="display:none">c</li></ul>`;
});

describe('evaluateCheck', () => {
  it('text-equals normalises whitespace', () => {
    expect(evaluateCheck(check('text-equals', 'Total: $42'), el(), [total])).toMatchObject({ status: 'pass', actual: 'Total: $42' });
    expect(evaluateCheck(check('text-equals', '$42'), el(), [total]).status).toBe('fail');
  });

  it('text-contains and text-not-contains', () => {
    expect(evaluateCheck(check('text-contains', '$42'), el(), [total]).status).toBe('pass');
    expect(evaluateCheck(check('text-contains', '$0'), el(), [total])).toMatchObject({ status: 'fail', actual: 'Total: $42' });
    expect(evaluateCheck(check('text-not-contains', '$0'), el(), [total]).status).toBe('pass');
    expect(evaluateCheck(check('text-not-contains', '$42'), el(), [total]).status).toBe('fail');
  });

  it('text checks fail when the element is missing', () => {
    expect(evaluateCheck(check('text-contains', '$42'), null, [total])).toMatchObject({ status: 'fail', detail: 'the element was not found' });
  });

  it('exists, visible and hidden', () => {
    expect(evaluateCheck(check('exists'), el(), [total]).status).toBe('pass');
    expect(evaluateCheck(check('exists'), null, [total]).status).toBe('fail');
    expect(evaluateCheck(check('visible'), el(), [total]).status).toBe('pass');
    expect(evaluateCheck(check('hidden'), null, [total]).status).toBe('pass');
    const hiddenLi: Locator = { kind: 'css', selector: 'li.i', nth: 2 };
    expect(evaluateCheck(check('hidden', undefined, hiddenLi), null, [total]).status).toBe('pass');
    expect(evaluateCheck(check('visible', undefined, hiddenLi), null, [total]).status).toBe('fail');
  });

  it('count uses the custom target or the primary locator', () => {
    expect(evaluateCheck(check('count', 3, { kind: 'css', selector: 'li.i' }), null, [total])).toMatchObject({ status: 'pass', actual: '3' });
    expect(evaluateCheck(check('count', 1), el(), [total]).status).toBe('pass');
    expect(evaluateCheck(check('count', 2), el(), [total])).toMatchObject({ status: 'fail', actual: '1' });
  });

  it('value-equals and value-contains read input values', () => {
    const qty: Locator = { kind: 'testid', attr: 'data-testid', value: 'qty' };
    expect(evaluateCheck(check('value-equals', '2', qty), null, [total]).status).toBe('pass');
    expect(evaluateCheck(check('value-contains', '3', qty), null, [total])).toMatchObject({ status: 'fail', actual: '2' });
  });

  it('judge is never evaluated', () => {
    expect(evaluateCheck(check('judge'), el(), [total])).toMatchObject({ status: 'judged', actual: 'Total: $42' });
  });
});

describe('evaluateCheckpoint', () => {
  it('retries until the expected text arrives', async () => {
    el()!.textContent = '$0';
    setTimeout(() => (el()!.textContent = '$42'), 300);
    const t0 = Date.now();
    const r = await evaluateCheckpoint([total], [check('text-contains', '$42')], 2000);
    expect(r.results[0]!.status).toBe('pass');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.facts?.text).toBe('$42');
  });

  it('gives up at the timeout and reports the last observation', async () => {
    el()!.textContent = '$0';
    const r = await evaluateCheckpoint([total], [check('text-contains', '$42')], 300);
    expect(r.results[0]).toMatchObject({ status: 'fail', actual: '$0' });
  });
});
