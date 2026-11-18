import { z } from 'zod';
import { LocatorSchema } from './locator';

export const RECORDING_SCHEMA_VERSION = 1;

/** The element a step or checkpoint acted on: locator candidates in priority order plus a short description. */
export const TargetSchema = z.object({
  locators: z.array(LocatorSchema).min(1),
  description: z.string(),
});
export type Target = z.infer<typeof TargetSchema>;

const stepBase = {
  index: z.number().int().nonnegative(),
  at: z.number(),
};

/** URL navigated to as a consequence of the step (not replayed separately). */
const navigation = z.string().optional();

export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ ...stepBase, kind: z.literal('initial-load'), url: z.string() }),
  z.object({ ...stepBase, kind: z.literal('navigate'), url: z.string() }),
  z.object({ ...stepBase, kind: z.literal('click'), target: TargetSchema, navigation }),
  z.object({ ...stepBase, kind: z.literal('dblclick'), target: TargetSchema, navigation }),
  z.object({ ...stepBase, kind: z.literal('input'), target: TargetSchema, value: z.string(), redacted: z.boolean().optional(), navigation }),
  z.object({ ...stepBase, kind: z.literal('select'), target: TargetSchema, value: z.string(), label: z.string(), navigation }),
  z.object({ ...stepBase, kind: z.literal('key'), target: TargetSchema, key: z.enum(['Enter', 'Escape', 'Tab']), navigation }),
]);
export type Step = z.infer<typeof StepSchema>;
export type StepKind = Step['kind'];
export type ActionStep = Exclude<Step, { kind: 'initial-load' } | { kind: 'navigate' }>;

export const NoteSchema = z.object({
  afterStep: z.number().int().nonnegative(),
  at: z.number(),
  text: z.string(),
});
export type Note = z.infer<typeof NoteSchema>;

export const ConsoleEntrySchema = z.object({
  step: z.number().int().nonnegative(),
  at: z.number(),
  level: z.enum(['error', 'warning', 'exception']),
  text: z.string(),
  /** Top stack frames, formatted as "fn (url:line:col)". */
  stack: z.array(z.string()).optional(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export const BodySchema = z.object({
  text: z.string(),
  /** Present when the body was cut at the size cap. */
  truncated: z.object({ originalSize: z.number().int() }).optional(),
});
export type Body = z.infer<typeof BodySchema>;

export const NetworkEntrySchema = z.object({
  step: z.number().int().nonnegative(),
  at: z.number(),
  method: z.string(),
  url: z.string(),
  resourceType: z.enum(['fetch', 'xhr']),
  status: z.number().int().optional(),
  durationMs: z.number().optional(),
  /** Set when the request failed without a response (network error, aborted). */
  errorText: z.string().optional(),
  requestHeaders: z.record(z.string(), z.string()).optional(),
  requestBody: BodySchema.optional(),
  responseBody: BodySchema.optional(),
});
export type NetworkEntry = z.infer<typeof NetworkEntrySchema>;

/** Facts captured about an element at a checkpoint, at record time and again at replay. */
export const ElementFactsSchema = z.object({
  text: z.string(),
  visible: z.boolean(),
  html: z.string(),
  value: z.string().optional(),
});
export type ElementFacts = z.infer<typeof ElementFactsSchema>;

export const CheckpointSchema = z.object({
  /** 1-based checkpoint number, as shown to users and agents. */
  id: z.number().int().positive(),
  /** The checkpoint sits after this step index. */
  afterStep: z.number().int().nonnegative(),
  at: z.number(),
  target: TargetSchema,
  actual: ElementFactsSchema,
  expected: z.string().optional(),
  contextOnly: z.boolean(),
  /** Blob ids of the cropped region and the full viewport screenshots. */
  screenshots: z.object({ region: z.string(), viewport: z.string() }),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const RecordingSchema = z.object({
  schemaVersion: z.literal(RECORDING_SCHEMA_VERSION),
  id: z.string().min(1),
  title: z.string(),
  startUrl: z.string(),
  viewport: z.object({ width: z.number(), height: z.number(), deviceScaleFactor: z.number() }),
  browserVersion: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  interrupted: z.object({ reason: z.string() }).optional(),
  steps: z.array(StepSchema).min(1),
  notes: z.array(NoteSchema),
  console: z.array(ConsoleEntrySchema),
  network: z.array(NetworkEntrySchema),
  checkpoints: z.array(CheckpointSchema),
  redactions: z.number().int().nonnegative(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const RecordingSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  startUrl: z.string(),
  createdAt: z.number(),
  stepCount: z.number().int(),
  checkpointCount: z.number().int(),
  interrupted: z.boolean(),
});
export type RecordingSummary = z.infer<typeof RecordingSummarySchema>;

/** Number of user-visible steps (excludes the synthetic initial-load step). */
export function countSteps(r: Pick<Recording, 'steps'>): number {
  return r.steps.filter((s) => s.kind !== 'initial-load').length;
}

export function summarize(r: Recording): RecordingSummary {
  return {
    id: r.id,
    title: r.title,
    startUrl: r.startUrl,
    createdAt: r.startedAt,
    stepCount: countSteps(r),
    checkpointCount: r.checkpoints.length,
    interrupted: !!r.interrupted,
  };
}

/** Requests that can change server state, which make replays drift. */
export function sideEffectRequests(r: Pick<Recording, 'network'>): { method: string; url: string }[] {
  return r.network.filter((n) => !['GET', 'HEAD', 'OPTIONS'].includes(n.method.toUpperCase())).map(({ method, url }) => ({ method, url }));
}
