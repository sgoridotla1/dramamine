import { describe, expect, it } from 'vitest';
import { CheckpointCheckSchema } from './checks';
import { computeVerdict } from './report';

describe('computeVerdict (session-replay: Replay verdict)', () => {
  it('is red when the baseline check fails (bug still exists)', () => {
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'fail' }] })).toBe('red');
  });

  it('is red when any evaluated check fails even if others pass', () => {
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'pass' }, { status: 'fail' }] })).toBe('red');
  });

  it('is green when all evaluated checks pass', () => {
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'pass' }, { status: 'pass' }] })).toBe('green');
  });

  it('is error, not red, when a checked element was not found', () => {
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'not-found' }] })).toBe('error');
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'fail' }, { status: 'not-found' }] })).toBe('error');
  });

  it('is unchecked when no checks were supplied', () => {
    expect(computeVerdict({ stepFailed: false, results: [] })).toBe('unchecked');
  });

  it('ignores judged checks for the verdict', () => {
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'judged' }] })).toBe('unchecked');
    expect(computeVerdict({ stepFailed: false, results: [{ status: 'judged' }, { status: 'pass' }] })).toBe('green');
  });

  it('is error when a step failed, regardless of checks', () => {
    expect(computeVerdict({ stepFailed: true, results: [{ status: 'pass' }] })).toBe('error');
    expect(computeVerdict({ stepFailed: true, results: [{ status: 'fail' }] })).toBe('error');
  });
});

describe('CheckpointCheckSchema', () => {
  it('requires a value for text ops', () => {
    expect(CheckpointCheckSchema.safeParse({ checkpoint: 1, op: 'text-contains' }).success).toBe(false);
    expect(CheckpointCheckSchema.safeParse({ checkpoint: 1, op: 'text-contains', value: '$42' }).success).toBe(true);
  });

  it('requires a number for count', () => {
    expect(CheckpointCheckSchema.safeParse({ checkpoint: 1, op: 'count', value: '2' }).success).toBe(false);
    expect(CheckpointCheckSchema.safeParse({ checkpoint: 1, op: 'count', value: 2 }).success).toBe(true);
  });

  it('allows exists, visible, hidden and judge without a value', () => {
    for (const op of ['exists', 'visible', 'hidden', 'judge'] as const) {
      expect(CheckpointCheckSchema.safeParse({ checkpoint: 1, op }).success).toBe(true);
    }
  });
});
