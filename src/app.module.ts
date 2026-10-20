import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthController } from './infrastructure/http/health.controller';
import { FinancialController } from './infrastructure/http/financial.controller';
import { FinancialService } from './application/financial-service';
import { createDataSource } from './infrastructure/database/data-source';
import { TypeOrmFinancialStore } from './infrastructure/database/typeorm-financial-store';
import { FinancialDiagnosticsService, MetricsController } from './infrastructure/http/financial-diagnostics';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}
  static register(source?: DataSource): DynamicModule {
    return { module: AppModule, controllers: [HealthController, FinancialController, MetricsController], providers: [
      { provide: DataSource, useFactory: async () => {
        const database = source ?? createDataSource();
        if (!database.isInitialized) await database.initialize();
        return database;
      } },
      FinancialDiagnosticsService,
      { provide: FinancialService, inject: [DataSource, FinancialDiagnosticsService],
        useFactory: (database: DataSource, diagnostics: FinancialDiagnosticsService) =>
          new FinancialService(new TypeOrmFinancialStore(database), diagnostics) },
    ] };
  }
  async onApplicationShutdown(): Promise<void> {
    if (this.source.isInitialized) await this.source.destroy();
  }
}
