import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Operations } from '../observability/operations';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Operations) private readonly operations: Operations) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  get() { return this.operations.collect(); }
}
