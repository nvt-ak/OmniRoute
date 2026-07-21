/**
 * Thinking configuration errors — TypeScript port of CLIProxyAPI
 * `internal/thinking/errors.go`. All map to HTTP 400.
 */

export type ThinkingErrorCode =
  | "INVALID_SUFFIX"
  | "UNKNOWN_LEVEL"
  | "THINKING_NOT_SUPPORTED"
  | "LEVEL_NOT_SUPPORTED"
  | "BUDGET_OUT_OF_RANGE"
  | "PROVIDER_MISMATCH";

export class ThinkingError extends Error {
  readonly code: ThinkingErrorCode;
  readonly model?: string;
  readonly statusCode = 400;

  constructor(code: ThinkingErrorCode, message: string, model?: string) {
    super(message);
    this.name = "ThinkingError";
    this.code = code;
    this.model = model;
  }
}
