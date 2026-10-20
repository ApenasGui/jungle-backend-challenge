# Distributed Wagering Processor

Implementação do [desafio da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

## Estado atual

API financeira em NestJS, TypeScript estrito e TypeORM, com domínio financeiro, migrations reversíveis e testes unitários, HTTP, integração e concorrência real. Os casos de uso processam abertura, apostas, ganhos, perdas e reversões em transações PostgreSQL, com lock por wallet, idempotência persistente e eventos gravados na outbox.

O worker SQS compartilha o caso de uso da API, persiste a inbox, publica a outbox e reprocessa referências pendentes. Inclui retry, DLQ e encerramento gracioso. Ainda faltam readiness e observabilidade completa. Os endpoints estão sem autenticação nesta etapa.

## Requisitos

- Bun 1.4.3 (runtime, gerenciador de pacotes e executor de testes).
- Docker com Compose e suporte a containers Linux.

## Preparação

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
bun run infra:up
bun run migration:run
bun run dev
```

O Bun carrega `.env` automaticamente. As credenciais do exemplo são exclusivas para desenvolvimento local.

Em outro terminal, na mesma pasta, execute `bun run worker`. Ele consome a fila de entrada, publica eventos e resolve referências pendentes. Expõe `/health/live` e `/metrics` na porta `3001`, configurável por `WORKER_PORT`.

## Comandos

```sh
bun run typecheck      # Verifica os tipos sem gerar arquivos.
bun run build          # Compila para dist/.
bun run test:unit      # Testa domínio e mapeamentos sem banco ou filas.
bun run test:integration # Testa PostgreSQL e configuração SQS locais reais.
bun run test:concurrency # Inicia três processos HTTP e testa disputas reais.
bun run dev            # Executa a API com reinício ao editar arquivos.
bun run start:prod     # Executa o código compilado.
bun run worker         # Executa consumidor, publisher e worker de referências.
bun run worker:prod    # Executa os workers compilados.
bun run infra:up       # Inicia PostgreSQL e LocalStack e aguarda saúde.
bun run infra:down     # Para os containers, preservando o volume do banco.
```

O Compose publica PostgreSQL em `127.0.0.1:55432` e SQS em `localhost:4566`. A porta 55432 evita conflito com uma instalação PostgreSQL já existente na máquina de desenvolvimento. Para alterá-la, ajuste `POSTGRES_PORT` e as URLs de banco em `.env`. Dentro do container, PostgreSQL continua na porta 5432. A API usa a porta `3000` por padrão. O script do LocalStack cria filas de entrada, DLQ e eventos; elas são recriadas ao recriar o container.

`bun run migration:run` aplica a migration inicial. `bun run migration:revert` desfaz a última migration; o rollback da migration inicial remove as tabelas e seus dados. Esses comandos exigem PostgreSQL disponível e `DATABASE_URL` configurada.

A migration cria wallets, transações, ledger, inbox e outbox, com índices, constraints e triggers. Foi aplicada no PostgreSQL 17.6 local e validada em testes reais, incluindo o ciclo `up → down → up` em banco temporário.

## Testes de integração

```sh
bun run infra:up
bun run test:integration
```

A suíte cria bancos exclusivos `wagering_test_<uuid>` e os remove ao terminar; não limpa nem reverte o banco de desenvolvimento. `TEST_DATABASE_ADMIN_URL` deve apontar para PostgreSQL local com permissão de criar bancos. Os testes de banco aplicam suas próprias migrations e não dependem da aplicação prévia em `wagering`. Uma interrupção forçada do processo pode deixar um banco temporário para limpeza manual.

São 85 testes unitários, 84 de integração/HTTP/mensageria e 5 de concorrência. Os testes reais cobrem persistência decimal, unicidade, imutabilidade, cadeia do ledger, reversões, rollback antes e durante o commit e configuração FIFO/DLQ do LocalStack. Também verificam contratos HTTP, replay, paginação, indisponibilidade e falha de gravação da outbox. Após cada teste financeiro, o saldo é comparado com a soma do ledger. Os testes de mensageria criam e removem filas próprias; não consomem as filas de desenvolvimento. `bun test --timeout 30000` executa todas as suítes e exige os containers ativos.

A suíte de concorrência inicia três processos reais da API em portas aleatórias: envia 50 duplicatas, disputa saldo, testa chaves globais entre wallets e verifica independência dos locks. Também reinicia um processo e confirma replay persistente. A suíte de mensageria encerra processos reais após commit/antes do ack e após envio/antes de marcar a outbox, verificando a recuperação. Inclui publishers concorrentes, retry, DLQ, TTL e shutdown. Os processos, bancos e filas temporários são removidos ao terminar.

## Entrada SQS

Envie à fila `wager-transactions.fifo` um envelope como abaixo, usando os IDs de uma wallet existente. Defina `MessageGroupId` como o `walletId` e um `MessageDeduplicationId` no envio.

```json
{
  "messageId": "request-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-19T12:00:00.000Z",
  "correlationId": "correlation-001",
  "data": {
    "idempotencyKey": "provider-a:bet-001",
    "providerId": "provider-a",
    "externalTransactionId": "bet-001",
    "walletId": "00000000-0000-4000-8000-000000000001",
    "playerId": "00000000-0000-4000-8000-000000000002",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O ack ocorre depois do commit. Rejeições de negócio também recebem ack; mensagens inválidas ou conflitantes seguem para a DLQ. Falhas transitórias têm backoff e até cinco recebimentos antes da DLQ. O banco garante idempotência mesmo quando a deduplicação FIFO não se aplica.

A outbox usa entrega pelo menos uma vez: consumidores dos eventos devem deduplicar por `eventId`. Referências pendentes são reavaliadas com backoff, até 100 tentativas ou 24 horas; ao esgotar o limite, são rejeitadas com `REFERENCE_NOT_FOUND`. Consulte `ARCHITECTURE.md` para os detalhes de recuperação.

## API HTTP

| Método e rota | Finalidade |
| --- | --- |
| `POST /wallets` | Criar wallet e abertura auditável |
| `GET /wallets/:walletId` | Consultar saldo e versão |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | Consultar lançamentos em ordem de versão |
| `POST /wallets/:walletId/reconciliation` | Comparar saldo com a soma do ledger |
| `POST /wagering/transactions` | Submeter operação com `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | Consultar pelo ID interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pelo ID do provedor |
| `GET /health/live` | Verificar processo vivo |
| `GET /metrics` | Métrica de divergências da reconciliação; demais métricas estão pendentes |

Valores monetários devem ser strings com exatamente duas casas. Campos desconhecidos são rejeitados. `OPENING` é interno. O cursor do ledger é opaco, restrito à wallet e usa sua versão monotônica; `limit` aceita de 1 a 100.

Respostas: `201` na criação de wallet; `200` em operações processadas e consultas; `202` para processamento pendente; `400` para contrato inválido; `404` para recurso ausente; `409` para conflito de chave/ID externo ou wallet duplicada; `422` para rejeição de negócio; `503` para indisponibilidade transitória. Erros internos retornam `500` sem detalhes SQL. Consultar uma transação rejeitada retorna `200` com seu estado; submetê-la novamente retorna `422` com `idempotentReplay: true`.

Exemplo em PowerShell, após iniciar a API:

```powershell
$wallet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType application/json -Body (@{
  playerId = [guid]::NewGuid().ToString()
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json)

$externalId = [guid]::NewGuid().ToString()
$operation = @{
  providerId = 'provider-a'; externalTransactionId = $externalId
  walletId = $wallet.id; playerId = $wallet.playerId
  roundId = 'round-1'; gameId = 'game-1'; kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -ContentType application/json -Headers @{
  'Idempotency-Key' = "provider-a:$externalId"
} -Body $operation
```

Repetir o último comando devolve a mesma transação e o saldo original, com `idempotentReplay: true`. Enviar o mesmo ID externo com outra chave retorna conflito, mesmo que o payload seja igual. `x-correlation-id` é opcional e acompanha os eventos; na ausência de um identificador válido, a API gera um UUID.

## Estrutura

- `src/domain`: regras de negócio sem NestJS ou ORM.
- `src/application`: casos de uso e contratos das dependências.
- `src/infrastructure`: HTTP, persistência e mensageria.
- `scripts`: comandos de manutenção explícitos.
- `tests/unit`, `tests/integration`, `tests/concurrency`: testes por finalidade.

Consulte `ARCHITECTURE.md` para decisões e pendências.
