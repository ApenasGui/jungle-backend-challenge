import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthController } from './infrastructure/http/health.controller';
import { FinancialController } from './infrastructure/http/financial.controller';
import { FinancialService } from './application/financial-service';
import { createDataSource } from './infrastructure/database/data-source';
import { TypeOrmFinancialStore } from './infrastructure/database/typeorm-financial-store';
import { FinancialDiagnosticsService } from './infrastructure/observability/financial-diagnostics';
import { MetricsController } from './infrastructure/http/metrics.controller';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient, queueConfig } from './infrastructure/messaging/sqs-config';
import { Operations } from './infrastructure/observability/operations';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly source: DataSource,
    @Inject(SQSClient) private readonly client: SQSClient,
    @Inject(Operations) private readonly operations: Operations) {}
  beforeApplicationShutdown(): void { this.operations.stop(); }
  static register(source?: DataSource): DynamicModule {
    return { module: AppModule, controllers: [HealthController, FinancialController, MetricsController], providers: [
      { provide: DataSource, useFactory: async () => {
        const database = source ?? createDataSource();
        if (!database.isInitialized) await database.initialize();
        return database;
      } },
      FinancialDiagnosticsService,
      { provide: SQSClient, useFactory: createSqsClient },
      { provide: Operations, inject: [DataSource, SQSClient, FinancialDiagnosticsService],
        useFactory: (database: DataSource, client: SQSClient, metrics: FinancialDiagnosticsService) =>
          new Operations(database, client, queueConfig(), metrics) },
      { provide: FinancialService, inject: [DataSource, FinancialDiagnosticsService],
        useFactory: (database: DataSource, diagnostics: FinancialDiagnosticsService) =>
          new FinancialService(new TypeOrmFinancialStore(database, diagnostics), diagnostics) },
    ] };
  }
  async onApplicationShutdown(): Promise<void> {
    this.client.destroy();
    if (this.source.isInitialized) await this.source.destroy();
  }
}
