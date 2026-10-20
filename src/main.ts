import 'reflect-metadata';
import { createApplication } from './bootstrap';

// Inicializa a API e habilita validação e encerramento controlado.
async function bootstrap(): Promise<void> {
  const app = await createApplication();
  try { await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0'); }
  catch (error) { await app.close(); throw error; }
}

void bootstrap().catch(() => {
  console.error(JSON.stringify({ level: 'error', event: 'api_start_failed' }));
  process.exitCode = 1;
});
