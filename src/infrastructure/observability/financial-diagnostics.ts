import type { FinancialDiagnostics } from '../../application/financial-store';
import { OperationalMetrics } from './metrics';

export class FinancialDiagnosticsService extends OperationalMetrics implements FinancialDiagnostics {
  reconciliationMismatch(walletId: string, correlationId: string): void {
    this.increment('wagering_reconciliation_mismatches_total');
    console.warn(JSON.stringify({ level: 'warn', event: 'reconciliation_mismatch', walletId, correlationId }));
  }
}
