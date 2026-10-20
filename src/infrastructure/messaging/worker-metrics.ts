export class WorkerMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  increment(name: string, value = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + value); }
  gauge(name: string, value: number): void { this.gauges.set(name, value); }
  observe(seconds: number): void {
    this.increment('wagering_processing_duration_seconds_count');
    this.increment('wagering_processing_duration_seconds_sum', seconds);
  }
  render(): string {
    return [...this.counters, ...this.gauges].map(([name, value]) => `${name} ${value}`).join('\n') + '\n';
  }
  // Os logs carregam identificadores e códigos, nunca o corpo financeiro.
  log(event: string, fields: Record<string, string | number | undefined> = {}): void {
    console.log(JSON.stringify({ level: 'info', event, ...fields }));
  }
}
