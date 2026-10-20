import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Confirma que o processo está vivo; não verifica banco ou fila.
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }
}
