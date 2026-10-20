import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { FinancialDiagnostics } from '../../application/financial-store';
import { WorkerMetrics } from '../messaging/worker-metrics';
import { Operations } from '../observability/operations';

export class FinancialDiagnosticsService extends WorkerMetrics implements FinancialDiagnostics {
  reconciliationMismatch(walletId: string, correlationId: string): void {
    this.increment('wagering_reconciliation_mismatches_total');
    console.warn(JSON.stringify({ level: 'warn', event: 'reconciliation_mismatch', walletId, correlationId }));
  }
  metrics(): string {
    return this.render();
  }
}
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Operations) private readonly operations: Operations) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  get() { return this.operations.collect(); }
}
