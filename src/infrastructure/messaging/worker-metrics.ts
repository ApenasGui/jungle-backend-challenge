export class WorkerMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  constructor() {
    for (const name of ['transactions_processed', 'transactions_rejected', 'transactions_failed',
      'transactions_pending_reference', 'duplicates', 'retries', 'dlq_messages', 'lock_conflicts',
      'reconciliation_mismatches']) this.increment(`wagering_${name}_total`, 0);
  }
  increment(name: string, value = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + value); }
  gauge(name: string, value: number): void { this.gauges.set(name, value); }
  removeGauge(name: string): void { this.gauges.delete(name); }
  lockConflict(): void { this.increment('wagering_lock_conflicts_total'); }
  retry(): void { this.increment('wagering_retries_total'); }
  observe(seconds: number): void {
    this.increment('wagering_processing_duration_seconds_count');
    this.increment('wagering_processing_duration_seconds_sum', seconds);
    for (const bound of [0.01, 0.05, 0.1, 0.5, 1, 5, 15, Infinity]) {
      this.increment(`wagering_processing_duration_seconds_bucket{le="${bound === Infinity ? '+Inf' : bound}"}`,
        seconds <= bound ? 1 : 0);
    }
  }
  render(): string {
    return '# TYPE wagering_processing_duration_seconds histogram\n'
      + [...this.counters, ...this.gauges].map(([name, value]) => `${name} ${value}`).join('\n') + '\n';
  }
  // Os logs carregam identificadores e códigos, nunca o corpo financeiro.
  log(event: string, fields: Record<string, string | number | undefined> = {}): void {
    console.log(JSON.stringify({ level: 'info', event, ...fields }));
  }
}
