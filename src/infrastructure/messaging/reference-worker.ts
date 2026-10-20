import type { DataSource } from 'typeorm';
import type { FinancialService } from '../../application/financial-service';
import { OperationalMetrics } from '../observability/metrics';

export class ReferenceWorker {
  constructor(private readonly source: DataSource, private readonly service: FinancialService,
    private readonly metrics = new OperationalMetrics()) {}
  async runOnce(now = new Date()): Promise<number> {
    const rows: { id: string; wallet_id: string; provider_id: string }[] = await this.source.query(`SELECT id,wallet_id,provider_id FROM wager_transactions
      WHERE status='PENDING_REFERENCE' AND (next_reference_attempt_at <= $1 OR reference_expires_at <= $1)
      ORDER BY next_reference_attempt_at,id LIMIT 20`, [now]);
    let processed = 0;
    for (const row of rows) {
      const result = await this.service.reprocessReference(row.id, now);
      if (result) {
        processed++;
        this.metrics.increment('wagering_reference_attempts_total');
        this.metrics.retry();
        if (result.status !== 'PENDING_REFERENCE') this.metrics.increment(`wagering_transactions_${result.status.toLowerCase()}_total`);
        this.metrics.log('reference_reprocessed', { transactionId: row.id, status: result.status,
          walletId: row.wallet_id, providerId: row.provider_id, correlationId: row.id });
      }
    }
    return processed;
  }
}
