import { z } from 'zod';

/**
 * A structured locator. Replay evaluates this structure directly; it is rendered
 * in Playwright syntax only for display (see render-locator.ts).
 *
 * Common modifiers:
 * - within:     resolve inside the element matched by this ancestor locator
 * - nth:        pick the nth (0-based) match; positional, so always fragile
 * - fragile:    only a positional locator could identify the element
 * - unverified: uniqueness could not be checked (element was detached)
 */
export type Locator =
  | ({ kind: 'testid'; attr: string; value: string } & LocatorModifiers)
  | ({ kind: 'role'; role: string; name?: string; exact?: boolean } & LocatorModifiers)
  | ({ kind: 'label'; text: string; exact?: boolean } & LocatorModifiers)
  | ({ kind: 'placeholder'; text: string; exact?: boolean } & LocatorModifiers)
  | ({ kind: 'text'; text: string; exact?: boolean } & LocatorModifiers)
  | ({ kind: 'css'; selector: string } & LocatorModifiers);

export interface LocatorModifiers {
  within?: Locator;
  nth?: number;
  fragile?: boolean;
  unverified?: boolean;
}

export type LocatorKind = Locator['kind'];

const modifiers = {
  within: z.lazy((): z.ZodType<Locator> => LocatorSchema).optional(),
  nth: z.number().int().nonnegative().optional(),
  fragile: z.boolean().optional(),
  unverified: z.boolean().optional(),
};

export const LocatorSchema: z.ZodType<Locator> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('testid'), attr: z.string().min(1), value: z.string(), ...modifiers }),
    z.object({ kind: z.literal('role'), role: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), ...modifiers }),
    z.object({ kind: z.literal('label'), text: z.string(), exact: z.boolean().optional(), ...modifiers }),
    z.object({ kind: z.literal('placeholder'), text: z.string(), exact: z.boolean().optional(), ...modifiers }),
    z.object({ kind: z.literal('text'), text: z.string(), exact: z.boolean().optional(), ...modifiers }),
    z.object({ kind: z.literal('css'), selector: z.string().min(1), ...modifiers }),
  ]),
) as z.ZodType<Locator>;

/** Test-id attributes checked by default, in priority order. */
export const DEFAULT_TESTID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-hook'] as const;
