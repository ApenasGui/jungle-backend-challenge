import type { INestApplication } from '@nestjs/common';
import { FinancialDiagnosticsService } from '../observability/financial-diagnostics';

interface Request {
  headers: Record<string, string | string[] | undefined>;
  method: string; route?: { path?: string }; body?: Record<string, unknown>;
  params?: Record<string, string>;
}
interface Response {
  statusCode: number; locals: Record<string, unknown>;
  setHeader(name: string, value: string): void;
  on(event: 'finish', callback: () => void): void;
}
export function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,100}$/.test(value) ? value : undefined;
}

export function installHttpObservability(app: INestApplication): void {
  const metrics = app.get(FinancialDiagnosticsService);
  app.use((request: Request, response: Response, next: () => void) => {
    const started = performance.now();
    const correlationId = safeIdentifier(request.headers['x-correlation-id']) ?? crypto.randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    response.on('finish', () => {
      // Só nomes de rotas entram nas métricas; IDs e payloads não viram labels.
      const route = request.route?.path ?? 'unmatched';
      metrics.increment(`wagering_http_responses_total{status="${response.statusCode}"}`);
      if (route === '/metrics' || route.startsWith('/health/')) return;
      const duration = (performance.now() - started) / 1000;
      metrics.observe(duration);
      metrics.log('http_completed', { correlationId, method: request.method, route,
        status: response.statusCode, durationSeconds: duration,
        transactionId: safeIdentifier(response.locals.transactionId ?? request.params?.transactionId),
        walletId: safeIdentifier(request.body?.walletId ?? request.params?.walletId),
        providerId: safeIdentifier(request.body?.providerId ?? request.params?.providerId) });
    });
    next();
  });
}
