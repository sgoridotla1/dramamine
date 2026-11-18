import { describe, expect, it } from 'vitest';
import { countSteps, RecordingSchema, sideEffectRequests, summarize } from './recording';
import { sampleRecording } from './test-samples';

describe('RecordingSchema', () => {
  it('accepts a valid recording', () => {
    expect(RecordingSchema.safeParse(sampleRecording()).success).toBe(true);
  });

  it('rejects a recording without steps', () => {
    const r = { ...sampleRecording(), steps: [] };
    expect(RecordingSchema.safeParse(r).success).toBe(false);
  });

  it('rejects an unknown step kind', () => {
    const r = sampleRecording() as unknown as { steps: Record<string, unknown>[] };
    r.steps[1] = { ...r.steps[1], kind: 'hover' };
    expect(RecordingSchema.safeParse(r).success).toBe(false);
  });

  it('rejects a target without locators', () => {
    const r = sampleRecording();
    const step = r.steps[1];
    if (step?.kind !== 'click') throw new Error('sample changed');
    step.target.locators = [];
    expect(RecordingSchema.safeParse(r).success).toBe(false);
  });

  it('rejects a checkpoint without screenshots', () => {
    const r = sampleRecording() as unknown as { checkpoints: Record<string, unknown>[] };
    delete r.checkpoints[0]!.screenshots;
    expect(RecordingSchema.safeParse(r).success).toBe(false);
  });

  it('rejects an unsupported key', () => {
    const r = sampleRecording() as unknown as { steps: Record<string, unknown>[] };
    r.steps[1] = { index: 1, kind: 'key', at: 1, key: 'F5', target: { description: 'x', locators: [{ kind: 'css', selector: 'x' }] } };
    expect(RecordingSchema.safeParse(r).success).toBe(false);
  });
});

describe('recording helpers', () => {
  it('counts steps without the initial load', () => {
    expect(countSteps(sampleRecording())).toBe(2);
  });

  it('summarizes', () => {
    expect(summarize(sampleRecording())).toEqual({
      id: 'rec_1',
      title: 'Cart total shows $0',
      startUrl: 'http://localhost:3000/products.html',
      createdAt: 1_000,
      stepCount: 2,
      checkpointCount: 1,
      interrupted: false,
    });
  });

  it('lists non-GET requests as side effects', () => {
    expect(sideEffectRequests(sampleRecording())).toEqual([{ method: 'POST', url: 'http://localhost:3000/api/cart' }]);
  });
});
