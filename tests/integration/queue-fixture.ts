import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { QueueConfig } from '../../src/infrastructure/messaging/sqs-config';

export async function createTestQueues() {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Use SQS local nos testes.');
  const client = new SQSClient({ endpoint, region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  const prefix = `test-${crypto.randomUUID()}`;
  const created: string[] = [];
  async function close() {
    try { for (const QueueUrl of created) await client.send(new DeleteQueueCommand({ QueueUrl })); }
    finally { client.destroy(); }
  }
  try {
    for (const kind of ['dlq', 'input', 'events']) {
      const result = await client.send(new CreateQueueCommand({ QueueName: `${prefix}-${kind}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2' } }));
      created.push(result.QueueUrl!);
    }
    const config: QueueConfig = { dlqUrl: created[0]!, inputUrl: created[1]!, eventsUrl: created[2]!, visibilitySeconds: 2, maxAttempts: 2 };
    return { client, config, close,
      async send(body: unknown, group = crypto.randomUUID()) {
        return client.send(new SendMessageCommand({ QueueUrl: config.inputUrl, MessageBody: JSON.stringify(body),
          MessageGroupId: group, MessageDeduplicationId: crypto.randomUUID() }));
      },
      async drain(url: string) {
        const bodies: Record<string, unknown>[] = [];
        for (let i = 0; i < 50; i++) {
          const response = await client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0, MessageAttributeNames: ['All'] }));
          if (!response.Messages?.length) break;
          for (const message of response.Messages) {
            bodies.push(JSON.parse(message.Body!));
            await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
          }
        }
        return bodies;
      },
      async count(url: string) {
        const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: url,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
        return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
      },
    };
  } catch (error) { await close(); throw error; }
}
