import type { Failure } from "../domain/contracts.js";

export class FailureError extends Error {
  constructor(readonly failure: Failure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "FailureError";
  }
}
export function fail(code: string, message: string, details: Omit<Failure, "code" | "message" | "retryable"> & { retryable?: boolean } = {}): never {
  throw new FailureError({ code, message, retryable: false, ...details });
}
export function failureOf(error: unknown, stage?: string): Failure {
  if (error instanceof FailureError) return { ...error.failure, stage: error.failure.stage ?? stage };
  // Browser/network exceptions may embed tokens or page content. Keep them out of API output.
  if (error instanceof Error && /timeout/i.test(error.name + error.message)) {
    return { code: "TIMEOUT", message: "The operation exceeded its time limit.", retryable: true, stage };
  }
  return { code: "INTERNAL_ERROR", message: "The operation failed unexpectedly. Use the request ID to inspect server logs.", retryable: false, stage };
}
