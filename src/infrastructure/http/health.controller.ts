import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Operations } from '../observability/operations';

@Controller('health')
export class HealthController {
  constructor(@Inject(Operations) private readonly operations: Operations) {}
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const result = await this.operations.ready();
    response.status(result.status === 'ready' ? 200 : 503);
    return result;
  }
  // Confirma que o processo está vivo; não verifica banco ou fila.
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }
}
