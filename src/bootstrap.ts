import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './infrastructure/http/api-exception.filter';

// HTTP usa o mesmo bootstrap nos testes e na execução normal.
export async function createApplication(source?: DataSource, silent = false) {
  const app = await NestFactory.create(AppModule.register(source), {
    logger: silent ? false : new ConsoleLogger({ json: true }), abortOnError: false,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
