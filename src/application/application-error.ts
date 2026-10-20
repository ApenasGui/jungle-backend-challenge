export type ApplicationErrorCode = 'INVALID_PAYLOAD' | 'NOT_FOUND' | 'CONFLICT' | 'SERVICE_UNAVAILABLE';

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode, message: string = code) {
    super(message);
    this.name = 'ApplicationError';
  }
}
