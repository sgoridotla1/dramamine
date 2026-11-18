import { describe, expect, it } from 'vitest';
import type { RawStep } from '../messages';
import { emptySession, finalize } from './finalize';

const target = (name: string) => ({ description: name, locators: [{ kind: 'role' as const, role: 'button', name }] });

function session(steps: RawStep[], navigations: { url: string; at: number }[] = []) {
  const s = emptySession({ id: 'r', title: 't', startUrl: 'http://x/a', viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, browserVersion: 'c', startedAt: 0 });
  s.steps = steps;
  s.navigations = navigations;
  return s;
}

describe('finalize', () => {
  it('starts with a synthetic initial-load step and numbers steps in time order', () => {
    const r = finalize(session([
      { kind: 'click', at: 200, target: target('B') },
      { kind: 'click', at: 100, target: target('A') },
    ]));
    expect(r.steps.map((s) => [s.index, s.kind])).toEqual([[0, 'initial-load'], [1, 'click'], [2, 'click']]);
    expect((r.steps[1] as { target: { description: string } }).target.description).toBe('A');
  });

  it('folds the click pair before a double-click on the same target', () => {
    const r = finalize(session([
      { kind: 'click', at: 100, target: target('X') },
      { kind: 'click', at: 180, target: target('X') },
      { kind: 'dblclick', at: 181, target: target('X') },
    ]));
    expect(r.steps.map((s) => s.kind)).toEqual(['initial-load', 'dblclick']);
  });

  it('keeps clicks on other targets before a double-click', () => {
    const r = finalize(session([
      { kind: 'click', at: 100, target: target('Y') },
      { kind: 'click', at: 180, target: target('X') },
      { kind: 'click', at: 260, target: target('X') },
      { kind: 'dblclick', at: 261, target: target('X') },
    ]));
    expect(r.steps.map((s) => s.kind)).toEqual(['initial-load', 'click', 'dblclick']);
  });

  it('attaches the first navigation after an action as its consequence; later ones become navigate steps', () => {
    const r = finalize(session([{ kind: 'click', at: 100, target: target('Cart') }], [
      { url: 'http://x/cart', at: 150 },
      { url: 'http://x/other', at: 400 },
      { url: 'http://x/late', at: 5000 },
    ]));
    expect(r.steps.map((s) => s.kind)).toEqual(['initial-load', 'click', 'navigate', 'navigate']);
    expect(r.steps[1]).toMatchObject({ navigation: 'http://x/cart' });
  });

  it('ignores a re-commit of the start page', () => {
    const r = finalize(session([], [{ url: 'http://x/a', at: 10 }]));
    expect(r.steps).toHaveLength(1);
  });

  it('links console and network entries to the step during which they happened', () => {
    const s = session([{ kind: 'click', at: 100, target: target('A') }, { kind: 'click', at: 300, target: target('B') }]);
    s.console = [{ at: 50, level: 'error', text: 'early' }, { at: 310, level: 'exception', text: 'boom' }];
    s.network = [{ at: 120, method: 'GET', url: 'http://x/api', resourceType: 'fetch' }];
    const r = finalize(s);
    expect(r.console.map((c) => c.step)).toEqual([0, 2]);
    expect(r.network[0]!.step).toBe(1);
  });
});
