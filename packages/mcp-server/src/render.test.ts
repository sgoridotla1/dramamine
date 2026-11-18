import type { ReplayReport } from '@str/shared';
import { describe, expect, it } from 'vitest';
import { sampleRecording } from '../../shared/src/test-samples';
import { recordingContent, renderRecordingLog, renderReplayReport, replayContent } from './render';

function report(overrides: Partial<ReplayReport> = {}): ReplayReport {
  const rec = sampleRecording();
  const cp = rec.checkpoints[0]!;
  return {
    recordingId: rec.id,
    title: rec.title,
    startUrl: rec.startUrl,
    startedAt: 0,
    durationMs: 3200,
    warnings: ['The recording made 1 non-GET request(s) (POST /api/cart). Server state may differ from the recording, so results may drift.'],
    sideEffects: [{ method: 'POST', url: 'http://localhost:3000/api/cart' }],
    steps: [
      { index: 1, kind: 'click', status: 'ok', match: { candidate: 0, locator: (rec.steps[1] as any).target.locators[0], fallback: false } },
      { index: 2, kind: 'click', status: 'ok', match: { candidate: 0, locator: (rec.steps[2] as any).target.locators[0], fallback: false } },
    ],
    checkpoints: [
      {
        checkpoint: 1,
        reached: true,
        expected: cp.expected,
        recorded: cp.actual,
        replayed: { text: '$0', visible: true, html: '<td data-testid="cart-total">$0</td>' },
        match: { candidate: 0, locator: cp.target.locators[0]!, fallback: false },
        screenshots: { region: 'rpl_r', viewport: 'rpl_v' },
        recordedScreenshots: cp.screenshots,
        checks: [{ check: { checkpoint: 1, op: 'text-contains', value: '$42' }, status: 'fail', actual: '$0' }],
      },
    ],
    globalChecks: [{ check: { op: 'no-uncaught-exceptions' }, status: 'pass', actual: 'no exceptions' }],
    console: [],
    network: [],
    verdict: 'red',
    ...overrides,
  };
}

describe('recording log', () => {
  it('renders the cart recording', () => {
    expect(renderRecordingLog(sampleRecording())).toMatchSnapshot();
  });

  it('marks interrupted recordings and redacted inputs', () => {
    const rec = sampleRecording();
    rec.interrupted = { reason: 'The recorded tab was closed' };
    rec.steps.push({ index: 3, kind: 'input', at: 5000, target: { description: "textbox 'Password'", locators: [{ kind: 'label', text: 'Password' }] }, value: '********', redacted: true });
    const log = renderRecordingLog(rec);
    expect(log).toContain('INTERRUPTED: The recorded tab was closed.');
    expect(log).toContain('value: ******** (redacted; pass redactedValues["3"] to replay)');
  });

  it('attaches checkpoint screenshots as image content after the log', () => {
    const content = recordingContent(sampleRecording(), { blob_r1: 'R', blob_v1: 'V' });
    expect(content.map((c) => (c.type === 'text' ? c.text.split('\n')[0] : `image:${c.data}`))).toEqual([
      '# STR: Cart total shows $0',
      'CP#1 region',
      'image:R',
      'CP#1 viewport',
      'image:V',
    ]);
  });
});

describe('replay report', () => {
  it('renders a red baseline', () => {
    expect(renderReplayReport(report())).toMatchSnapshot();
  });

  it('renders a green verification', () => {
    const r = report({ verdict: 'green', warnings: [] });
    r.checkpoints[0]!.replayed = { text: '$42', visible: true, html: '<td data-testid="cart-total">$42</td>' };
    r.checkpoints[0]!.checks = [{ check: { checkpoint: 1, op: 'text-contains', value: '$42' }, status: 'pass', actual: '$42' }];
    expect(renderReplayReport(r)).toMatchSnapshot();
  });

  it('renders an error with the failed step, skipped steps and unreached checkpoints', () => {
    const r = report({
      verdict: 'error',
      failedStep: 2,
      steps: [
        { index: 1, kind: 'click', status: 'ok', match: { candidate: 1, locator: { kind: 'css', selector: 'div:nth-of-type(1) > button', fragile: true }, fallback: true } },
        { index: 2, kind: 'click', status: 'failed', error: "getByRole('link', { name: 'Cart' }) matched no elements", tried: ["getByRole('link', { name: 'Cart' })"] },
      ],
      globalChecks: [],
    });
    r.checkpoints[0] = { ...r.checkpoints[0]!, reached: false, replayed: undefined, screenshots: undefined, match: undefined, checks: [{ check: { checkpoint: 1, op: 'text-contains', value: '$42' }, status: 'not-evaluated', detail: 'step 2 failed before this checkpoint' }] };
    expect(renderReplayReport(r)).toMatchSnapshot();
  });

  it('renders an unchecked replay with a judged check and replay errors', () => {
    const r = report({
      verdict: 'unchecked',
      warnings: [],
      globalChecks: [],
      console: [{ step: 2, at: 0, level: 'exception', text: "TypeError: Cannot read properties of undefined (reading 'title')" }],
      network: [{ step: 2, at: 0, method: 'GET', url: 'http://localhost:3000/api/fail', resourceType: 'fetch', status: 500 }],
    });
    r.checkpoints[0]!.checks = [{ check: { checkpoint: 1, op: 'judge' }, status: 'judged', actual: '$0' }];
    expect(renderReplayReport(r)).toMatchSnapshot();
  });

  it('attaches replayed screenshots only where they help, unless asked for all or none', () => {
    const images = { blob_r1: 'R0', rpl_r: 'R1', rpl_v: 'V1' };
    const labels = (c: ReturnType<typeof replayContent>) => c.filter((x) => x.type === 'text').slice(1).map((x) => (x as { text: string }).text);
    // The checkpoint's check failed: its replayed screenshots are worth seeing; the recorded region is already known.
    expect(labels(replayContent(report(), images))).toEqual(['CP#1 region, replayed', 'CP#1 viewport, replayed']);
    expect(labels(replayContent(report(), images, 'all'))).toEqual(['CP#1 region, recorded', 'CP#1 region, replayed', 'CP#1 viewport, replayed']);
    expect(replayContent(report(), images, 'none')).toHaveLength(1);
    // A passing checkpoint gets no images by default.
    const green = report();
    green.checkpoints[0]!.checks = [{ check: { checkpoint: 1, op: 'text-contains', value: '$42' }, status: 'pass', actual: '$42' }];
    expect(labels(replayContent(green, images))).toEqual([]);
  });
});
