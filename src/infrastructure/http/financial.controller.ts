import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { FinancialService } from '../../application/financial-service';
import type { EventContext } from '../../application/integration-events';
import { FinancialDiagnosticsService } from '../observability/financial-diagnostics';
import { safeIdentifier } from './http-observability';
import { ProviderAuthGuard } from './provider-auth.guard';

interface ResponseStatus { status(code: number): unknown; locals: Record<string, unknown> }
function eventContext(value?: string): EventContext {
  return { correlationId: safeIdentifier(value) ?? crypto.randomUUID() };
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class FinancialController {
  constructor(@Inject(FinancialService) private readonly service: FinancialService,
    @Inject(FinancialDiagnosticsService) private readonly metrics: FinancialDiagnosticsService) {}

  @Post('wallets')
  createWallet(@Body() body: unknown, @Headers('x-correlation-id') correlation?: string) {
    return this.service.createWallet(body, eventContext(correlation));
  }
  @Get('wallets/:walletId')
  wallet(@Param('walletId') id: string) { return this.service.getWallet(id); }

  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.service.getLedger(id, cursor, limit);
  }
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') id: string, @Headers('x-correlation-id') correlation?: string) {
    return this.service.reconcile(id, eventContext(correlation));
  }
  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: ResponseStatus, @Headers('x-correlation-id') correlation?: string) {
    const result = await this.service.submit(body, key, eventContext(correlation));
    response.locals.transactionId = result.transactionId;
    if (result.idempotentReplay) this.metrics.increment('wagering_duplicates_total');
    else this.metrics.increment(`wagering_transactions_${result.status.toLowerCase()}_total`);
    response.status(result.status === 'REJECTED' ? 422 : result.status === 'FAILED' ? 500
      : result.status === 'PROCESSED' ? 200 : 202);
    return result;
  }
  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId') id: string) { return this.service.getTransaction(id); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  external(@Param('providerId') provider: string, @Param('externalTransactionId') external: string) {
    return this.service.getExternal(provider, external);
  }
}
