import { expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

// Confere a infraestrutura criada pelo Compose sem consumir mensagens existentes.
test('LocalStack disponibiliza as três filas FIFO e a política de DLQ', async () => {
  const endpoint = new URL(process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Este teste exige SQS local.');
  }
  const client = new SQSClient({ endpoint: endpoint.toString(), region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  try {
    const attributes = new Map<string, Record<string, string>>();
    for (const name of ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo']) {
      const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(QueueUrl).toBeDefined();
      const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl,
        AttributeNames: ['FifoQueue', 'QueueArn', 'RedrivePolicy', 'VisibilityTimeout'] }));
      expect(Attributes?.FifoQueue).toBe('true');
      attributes.set(name, Attributes!);
    }
    const input = attributes.get('wager-transactions.fifo')!;
    const redrive = JSON.parse(input.RedrivePolicy!);
    expect(redrive.deadLetterTargetArn).toBe(attributes.get('wager-transactions-dlq.fifo')!.QueueArn);
    expect(String(redrive.maxReceiveCount)).toBe('5');
    expect(input.VisibilityTimeout).toBe('30');
  } finally { client.destroy(); }
}, 15000);
