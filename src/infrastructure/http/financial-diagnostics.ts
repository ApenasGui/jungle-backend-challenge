import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { FinancialDiagnostics } from '../../application/financial-store';

export class FinancialDiagnosticsService implements FinancialDiagnostics {
  private mismatches = 0;
  reconciliationMismatch(walletId: string, correlationId: string): void {
    this.mismatches++;
    console.warn(JSON.stringify({ level: 'warn', event: 'reconciliation_mismatch', walletId, correlationId }));
  }
  metrics(): string {
    return '# HELP wagering_reconciliation_mismatches_total Divergencias detectadas na reconciliacao\n'
      + '# TYPE wagering_reconciliation_mismatches_total counter\n'
      + `wagering_reconciliation_mismatches_total ${this.mismatches}\n`;
  }
}
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(FinancialDiagnosticsService) private readonly diagnostics: FinancialDiagnosticsService) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  get() { return this.diagnostics.metrics(); }
}
