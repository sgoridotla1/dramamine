import { z } from 'zod';
import { LocatorSchema } from './locator';

export const CHECKPOINT_OPS = [
  'text-equals',
  'text-contains',
  'text-not-contains',
  'exists',
  'visible',
  'hidden',
  'count',
  'value-equals',
  'value-contains',
  'judge',
] as const;
export type CheckpointOp = (typeof CHECKPOINT_OPS)[number];

/** Ops that need a `value`. */
export const OPS_WITH_VALUE: readonly CheckpointOp[] = ['text-equals', 'text-contains', 'text-not-contains', 'count', 'value-equals', 'value-contains'];

export const CheckpointCheckSchema = z
  .object({
    checkpoint: z.number().int().positive().describe('1-based checkpoint number from the recording'),
    op: z.enum(CHECKPOINT_OPS),
    value: z.union([z.string(), z.number()]).optional().describe('Expected text, value or count; required by every op except exists/visible/hidden/judge'),
    target: LocatorSchema.optional().describe("Element to check instead of the checkpoint's own target"),
  })
  .refine((c) => !OPS_WITH_VALUE.includes(c.op) || c.value !== undefined, { message: 'this op requires a value' })
  .refine((c) => c.op !== 'count' || typeof c.value === 'number', { message: 'count requires a numeric value' });
export type CheckpointCheck = z.infer<typeof CheckpointCheckSchema>;

export const GlobalCheckSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('no-uncaught-exceptions') }),
  z.object({ op: z.literal('no-http-errors'), urlPattern: z.string().optional().describe('Only consider request URLs containing this substring') }),
]);
export type GlobalCheck = z.infer<typeof GlobalCheckSchema>;

export const CheckStatusSchema = z.enum(['pass', 'fail', 'judged', 'not-evaluated']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z.object({
  check: z.union([CheckpointCheckSchema, GlobalCheckSchema]),
  status: CheckStatusSchema,
  /** What was observed, e.g. the element text. */
  actual: z.string().optional(),
  detail: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
