import { z } from 'zod';
import { CheckResultSchema, type CheckResult } from './checks';
import { LocatorSchema } from './locator';
import { ConsoleEntrySchema, ElementFactsSchema, NetworkEntrySchema } from './recording';

export const VerdictSchema = z.enum(['red', 'green', 'error', 'unchecked']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const MatchSchema = z.object({
  /** Index into the target's locator candidates. */
  candidate: z.number().int().nonnegative(),
  locator: LocatorSchema,
  /** True when a candidate other than the primary one matched. */
  fallback: z.boolean(),
});
export type Match = z.infer<typeof MatchSchema>;

export const StepResultSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  match: MatchSchema.optional(),
  error: z.string().optional(),
  /** Locators tried, rendered, when the step failed. */
  tried: z.array(z.string()).optional(),
  durationMs: z.number().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const CheckpointResultSchema = z.object({
  checkpoint: z.number().int().positive(),
  reached: z.boolean(),
  expected: z.string().optional(),
  recorded: ElementFactsSchema,
  replayed: ElementFactsSchema.optional(),
  match: MatchSchema.optional(),
  error: z.string().optional(),
  screenshots: z.object({ region: z.string(), viewport: z.string() }).optional(),
  recordedScreenshots: z.object({ region: z.string(), viewport: z.string() }),
  checks: z.array(CheckResultSchema),
});
export type CheckpointResult = z.infer<typeof CheckpointResultSchema>;

export const ReplayReportSchema = z.object({
  recordingId: z.string(),
  title: z.string(),
  startUrl: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
  warnings: z.array(z.string()),
  sideEffects: z.array(z.object({ method: z.string(), url: z.string() })),
  steps: z.array(StepResultSchema),
  checkpoints: z.array(CheckpointResultSchema),
  globalChecks: z.array(CheckResultSchema),
  console: z.array(ConsoleEntrySchema),
  network: z.array(NetworkEntrySchema),
  failedStep: z.number().int().optional(),
  verdict: VerdictSchema,
});
export type ReplayReport = z.infer<typeof ReplayReportSchema>;

/**
 * error     - a step could not be performed, or an element a check needs was not found
 * red       - at least one evaluated check failed
 * green     - every evaluated check passed (and at least one was evaluated)
 * unchecked - nothing deterministic was evaluated
 * Judged and not-evaluated checks never affect the verdict.
 */
export function computeVerdict(input: { stepFailed: boolean; results: Pick<CheckResult, 'status'>[] }): Verdict {
  if (input.stepFailed || input.results.some((r) => r.status === 'not-found')) return 'error';
  const evaluated = input.results.filter((r) => r.status === 'pass' || r.status === 'fail');
  if (evaluated.some((r) => r.status === 'fail')) return 'red';
  if (evaluated.length > 0) return 'green';
  return 'unchecked';
}
