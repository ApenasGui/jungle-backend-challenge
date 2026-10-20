import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApplication } from './bootstrap';

// Inicializa a API e habilita validação e encerramento controlado.
async function bootstrap(): Promise<void> {
  const app = await createApplication();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  Logger.error(error, undefined, 'Bootstrap');
  process.exitCode = 1;
});
