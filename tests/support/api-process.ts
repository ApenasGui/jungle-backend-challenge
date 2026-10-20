import { createApplication } from '../../src/bootstrap';

// Processo real usado pela suíte de concorrência, com encerramento pelo pipe de controle.
async function run(): Promise<void> {
  const app = await createApplication(undefined, true);
  await app.listen(0, '127.0.0.1');
  console.log(JSON.stringify({ url: await app.getUrl() }));
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).includes('stop')) break;
  }
  await app.close();
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
