import type { ErrorCode } from '@str/shared';

/** An error with a protocol error code, reported to the agent as-is. */
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
