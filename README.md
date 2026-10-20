# Distributed Wagering Processor

Implementação do [desafio da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

## Estado atual

API financeira em NestJS, TypeScript estrito e TypeORM, com domínio financeiro, migrations reversíveis e testes unitários, HTTP, integração e concorrência real. Os casos de uso processam abertura, apostas, ganhos, perdas e reversões em transações PostgreSQL, com lock por wallet, idempotência persistente e eventos gravados na outbox.

O worker SQS compartilha o caso de uso da API, persiste a inbox, publica a outbox e reprocessa referências pendentes. Inclui retry, DLQ e encerramento gracioso. Readiness, logs JSON correlacionados e métricas Prometheus estão implementados. Autenticação externa foi deixada fora do escopo, com ponto de extensão explícito e decisão documentada.

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

Em outro terminal, na mesma pasta, execute `bun run worker`. Ele consome a fila de entrada, publica eventos e resolve referências pendentes. Expõe `/health/live`, `/health/ready` e `/metrics` na porta `3001`, configurável por `WORKER_PORT`.

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

São 88 testes unitários, 98 de integração/HTTP/mensageria/observabilidade e 5 de concorrência. Os testes reais cobrem persistência decimal, unicidade, imutabilidade, cadeia do ledger, reversões, rollback antes e durante o commit e configuração FIFO/DLQ do LocalStack. Também verificam contratos HTTP, replay, paginação, indisponibilidade e falha de gravação da outbox. Após cada teste financeiro, o saldo é comparado com a soma do ledger. Os testes de mensageria criam e removem filas próprias; não consomem as filas de desenvolvimento. `bun test --timeout 30000` executa todas as suítes e exige os containers ativos.

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
| `GET /health/ready` | Verificar PostgreSQL e as três filas SQS; 200 ou 503 |
| `GET /metrics` | Métricas Prometheus do processo e estado persistido |

Valores monetários devem ser strings com exatamente duas casas. Campos desconhecidos são rejeitados. `OPENING` é interno. O cursor do ledger é opaco, restrito à wallet e usa sua versão monotônica; `limit` aceita de 1 a 100.

Respostas: `201` na criação de wallet; `200` em operações processadas e consultas; `202` para processamento pendente; `400` para contrato inválido; `413` para corpo acima do limite do parser; `404` para recurso ausente; `409` para conflito de chave/ID externo ou wallet duplicada; `422` para rejeição de negócio; `503` para indisponibilidade transitória. Erros internos retornam `500` sem detalhes SQL. Consultar uma transação rejeitada retorna `200` com seu estado; submetê-la novamente retorna `422` com `idempotentReplay: true`.

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

## Verificação operacional

Com API e worker ativos:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
Invoke-RestMethod http://localhost:3001/health/ready
(Invoke-WebRequest http://localhost:3000/metrics).Content
(Invoke-WebRequest http://localhost:3001/metrics).Content
```

Readiness responde `503` quando PostgreSQL ou qualquer fila configurada está inacessível. Liveness indica apenas que o processo responde. As sondas não consomem mensagens. `x-correlation-id` é devolvido no HTTP e acompanha os eventos; quando ausente ou inválido, recebe um UUID.

| Métrica | Interpretação |
| --- | --- |
| `wagering_transactions_current{status="..."}` | Quantidade persistida em cada estado, incluindo abertura |
| `wagering_transactions_<status>_total` | Resultados novos observados pelo processo na entrada ou reprocessamento |
| `wagering_duplicates_total` | Replays detectados pelo processo |
| `wagering_retries_total` | Novas tentativas de SQL, mensagem, referência ou publicação |
| `wagering_dlq_messages_total` | Encaminhamentos à DLQ confirmados pelo consumidor |
| `wagering_lock_conflicts_total` | Deadlocks e timeouts de lock detectados pelo adaptador |
| `wagering_outbox_pending` | Eventos ainda não marcados como publicados |
| `wagering_outbox_lag_seconds` | Idade do evento pendente mais antigo; zero quando vazia |
| `wagering_processing_duration_seconds` | Histograma de latência HTTP ou de processamento SQS |
| `wagering_reconciliation_mismatches_total` | Divergências encontradas pela reconciliação |

Contadores e histogramas pertencem a cada processo e reiniciam com ele. Os gauges consultados no banco usam cache local de cinco segundos, com uma única coleta para scrapes simultâneos. Contadores locais não ficam em cache e readiness sempre consulta suas dependências. Os gauges representam o mesmo estado compartilhado em todas as instâncias: não devem ser somados entre réplicas. Os campos `*_collection_success` valem zero quando a coleta falha; nesse caso, os gauges afetados são omitidos. Métricas são operacionais, não substituem a auditoria persistida.

Para três instâncias da API, abra três terminais e execute `bun run start` com `PORT` definido como `3000`, `3002` e `3003`, respectivamente (`$env:PORT='3002'` no PowerShell). Workers adicionais devem ter `WORKER_PORT` diferente, usando o mesmo banco e filas. A suíte `bun run test:concurrency` já automatiza a validação com três processos isolados.

Se a outbox acumular eventos, verifique readiness do worker, configuração da fila de eventos e logs de retry. Se houver mensagem na DLQ, investigue o `failureCode` e consulte a transação antes de reenviar. Preserve `messageId`, chave de idempotência e payload original ao repetir uma mensagem transitória. Uma transação terminal `FAILED` ou `REJECTED` não muda por replay; não altere registros terminais manualmente para forçar processamento.

## Estrutura

- `src/domain`: regras de negócio sem NestJS ou ORM.
- `src/application`: casos de uso e contratos das dependências.
- `src/infrastructure`: HTTP, persistência e mensageria.
- `scripts`: comandos de manutenção explícitos.
- `tests/unit`, `tests/integration`, `tests/concurrency`: testes por finalidade.

Consulte `ARCHITECTURE.md` para decisões e limitações e [CHALLENGE_REVIEW.md](CHALLENGE_REVIEW.md) para a revisão de aderência ao enunciado.
