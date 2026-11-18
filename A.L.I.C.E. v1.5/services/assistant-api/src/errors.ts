import { ErrorCode, type ErrorResponse } from "@assistant/shared";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, details: error.details } } };
  }
  return {
    status: 500,
    body: { error: { code: ErrorCode.INTERNAL_ERROR, message: "An unexpected error occurred.", details: null } },
  };
}
