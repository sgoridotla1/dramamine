export interface FixtureVariant {
  fixed: boolean;
  renamed: boolean;
}

export interface FixtureServer {
  url: string;
  state: { cart: unknown[]; variant: FixtureVariant; requests: string[] };
  setVariant(v: Partial<FixtureVariant>): void;
  reset(): void;
  close(): Promise<void>;
}

export const PRODUCTS: { id: number; name: string; price: number }[];
export function createFixtureServer(opts?: { port?: number }): Promise<FixtureServer>;
