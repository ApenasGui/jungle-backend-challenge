import { SQSClient } from '@aws-sdk/client-sqs';

export interface QueueConfig {
  inputUrl: string; dlqUrl: string; eventsUrl: string;
  visibilitySeconds: number; maxAttempts: number;
}
export function queueConfig(): QueueConfig {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  const base = `${endpoint}/queue/${process.env.AWS_REGION ?? 'us-east-1'}/000000000000`;
  return { inputUrl: process.env.SQS_QUEUE_URL ?? `${base}/wager-transactions.fifo`,
    dlqUrl: process.env.SQS_DLQ_URL ?? `${base}/wager-transactions-dlq.fifo`,
    eventsUrl: process.env.SQS_EVENTS_QUEUE_URL ?? `${base}/wager-events.fifo`,
    visibilitySeconds: 30, maxAttempts: 5 };
}
export function createSqsClient(): SQSClient {
  return new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566', maxAttempts: 1 });
}
