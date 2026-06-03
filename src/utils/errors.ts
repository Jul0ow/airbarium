export type ErrorDetails = Record<string, unknown> | undefined;

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
