export type ErrorDetails = Record<string, unknown> | undefined;

// Structural shape of a Zod issue — avoids coupling to a specific ZodError /
// core $ZodError type across zod's public/internal boundary.
type ZodIssueLike = { path: ReadonlyArray<PropertyKey>; code: string; message: string };

/**
 * Single, uniform shape for Zod validation issues surfaced in `error.details`.
 * Used by every route/middleware that reports a validation failure so the mobile
 * client sees one consistent `details.issues` format across all endpoints.
 */
export const zodIssues = (error: {
  issues: ReadonlyArray<ZodIssueLike>;
}): { issues: Array<Record<string, unknown>> } => ({
  issues: error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
});

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, status: number, details?: ErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: ErrorDetails) {
    super('NOT_FOUND', message, 404, details);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details?: ErrorDetails) {
    super('UNAUTHORIZED', message, 401, details);
    this.name = 'UnauthorizedError';
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type', details?: ErrorDetails) {
    super('UNSUPPORTED_MEDIA_TYPE', message, 415, details);
    this.name = 'UnsupportedMediaTypeError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request body', details?: ErrorDetails) {
    super('VALIDATION', message, 400, details);
    this.name = 'ValidationError';
  }
}
