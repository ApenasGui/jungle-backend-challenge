import { createDataSource } from '../../src/infrastructure/database/data-source';
import { createSqsClient, queueConfig } from '../../src/infrastructure/messaging/sqs-config';
import { SqsConsumer } from '../../src/infrastructure/messaging/sqs-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { FinancialService } from '../../src/application/financial-service';
import { TypeOrmFinancialStore } from '../../src/infrastructure/database/typeorm-financial-store';

async function run() {
  const source = createDataSource(); await source.initialize();
  const client = createSqsClient(); const config = { ...queueConfig(), visibilitySeconds: 2 };
  const pause = async () => { console.log(JSON.stringify({ event: 'test_crash_point' })); await Bun.sleep(60000); };
  try {
    if (process.argv[2] === 'consumer') {
      const service = new FinancialService(new TypeOrmFinancialStore(source), { reconciliationMismatch() {} });
      const consumer = new SqsConsumer(client, config, service, undefined, { afterCommit: pause });
      await consumer.pollOnce(5);
    } else {
      await new OutboxPublisher(source, client, config.eventsUrl, undefined, { afterPublish: pause }).publishOnce();
    }
  } finally { client.destroy(); await source.destroy(); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
