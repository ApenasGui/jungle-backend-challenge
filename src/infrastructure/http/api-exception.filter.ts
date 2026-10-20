import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { ApplicationError } from '../../application/application-error';
import { DomainError } from '../../domain/domain-error';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  // Erros de SQL e payloads financeiros nunca são expostos na resposta ou nos logs.
  catch(error: unknown, host: ArgumentsHost): void {
    let status = 500; let code = 'INTERNAL_ERROR';
    if (error instanceof ApplicationError) {
      status = { INVALID_PAYLOAD: 400, NOT_FOUND: 404, CONFLICT: 409, SERVICE_UNAVAILABLE: 503 }[error.code];
      code = error.message;
    } else if (error instanceof DomainError) {
      code = error.code;
      status = code === 'IDEMPOTENCY_CONFLICT' ? 409
        : ['INVALID_TRANSACTION_STATE', 'INVALID_LEDGER'].includes(code) ? 500 : 400;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
    }
    if (status >= 500) console.error(JSON.stringify({ level: 'error', event: 'http_error', code, status,
      correlationId: host.switchToHttp().getRequest().headers['x-correlation-id'] }));
    const response = host.switchToHttp().getResponse();
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json({ statusCode: status, code });
  }
}
