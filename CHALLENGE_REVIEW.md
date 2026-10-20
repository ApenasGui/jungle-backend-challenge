# Revisão de aderência — 20/10/2026

Referência: [README oficial do desafio](https://github.com/junglegaming/backend-challenge/blob/main/README.md).

Revisão executada na branch `test/debug`, baseada em `fb3fb16`. Este relatório relaciona o código e os testes existentes com as áreas do enunciado; não é uma garantia de ausência de bugs nem uma previsão da avaliação.

## Evidências por área

| Área do README | Implementação / evidência local | Resultado |
| --- | --- | --- |
| Stack e migrations | `package.json`, `tsconfig.json`, `compose.yaml`; migration `up/down/up` em PostgreSQL real | Verificado |
| Domínio e dinheiro | `Money`, `Wallet`, `WagerTransaction`, ledger e classes de mensageria; testes unitários | Verificado; dinheiro permanece decimal/string |
| Persistência | `financial.schemas.ts`, mappers e migration com constraints e triggers | Unicidade, saldo não negativo e ledger imutável exercitados no banco |
| API e idempotência | `financial-service.ts`, controller, `http-api.test.ts` | Rotas, replay, conflitos, paginação e erros cobertos |
| Concorrência | `http-concurrency.test.ts` | Três processos, 50 duplicatas, disputa de saldo e wallets independentes |
| SQS e atomicidade | `messaging.test.ts` | Inbox, rollback da outbox, redelivery, retry e DLQ em LocalStack |
| Recuperação | Processos auxiliares encerrados após commit e após envio | Outro consumidor/publisher recupera o trabalho |
| Referências | Worker com lock por wallet, backoff e expiração | Referência anterior à BET, dois workers, TTL e limite de tentativas |
| Observabilidade | `observability.test.ts`, `/health/*`, `/metrics` | Banco/fila indisponíveis, correlação, lag, locks e reconciliação |
| Autenticação | `ProviderAuthGuard` e decisão em `ARCHITECTURE.md` | Acesso aberto explícito; integração com IdP não implementada |
| Documentação | `README.md`, `ARCHITECTURE.md` | Setup, comandos, decisões, métricas e limitações |

## Problemas reproduzidos e corrigidos

1. **HTTP acima do limite:** um JSON maior que o limite padrão do parser recebia `500 INTERNAL_ERROR`. Agora recebe `413 PAYLOAD_TOO_LARGE`, sem criar transação. O teste falhou antes da correção.
2. **Tentativa adicional de referência:** após 99 tentativas, a centésima consulta sem referência agendava outra execução. Agora encerra como `REJECTED / REFERENCE_NOT_FOUND` na centésima. Uma referência disponível nessa última tentativa ainda é processada. O teste de esgotamento falhou antes da correção.
3. **Encapsulamento da outbox:** a criação passa pela factory `OutboxMessage.enqueue`, preservando uma cópia do envelope. Métodos recusam reagendar ou alterar a data de um evento já publicado. Testes cobrem cópia defensiva, reidratação, backoff e estado publicado.

Também foi incluído um teste que simula divergência apenas em banco descartável: a reconciliação sinaliza a diferença, registra log/métrica e não modifica o saldo. O teste restaura a consistência antes da limpeza.

## Pontos que precisam ser apresentados com clareza

- **Reversões:** a regra implementada é mais restritiva que a formulação por tipo do enunciado: uma transação não aceita uma segunda reversão processada, mesmo alternando REFUND e ROLLBACK. Está documentada e testada como proteção contra crédito duplicado, mas representa uma interpretação de negócio a discutir com o avaliador. Esta revisão não mudou essa regra nem o índice existente.
- **FAILED com banco fora do ar:** se o banco permanecer inacessível ao esgotar retries, não há como gravar o estado SQL naquele instante. O comando fica preservado na DLQ; o registro `FAILED` é tentado quando o banco está acessível. Isso está documentado, e não deve ser apresentado como auditoria SQL garantida durante indisponibilidade.
- **Entrega de eventos:** a outbox oferece entrega pelo menos uma vez. O consumidor externo deve deduplicar `eventId`; não há um serviço downstream de produção neste repositório. FIFO não substitui essa responsabilidade.
- **Shutdown:** há testes de parada do runtime e conclusão da mensagem em andamento, além de encerramento forçado de processos reais. Isso não equivale a testar todos os sinais POSIX e condições de rede em Linux/AWS.
- **Ambiente:** a integração foi exercitada com PostgreSQL e LocalStack locais. Não houve teste em conta AWS real, benchmark de carga ou avaliação de infraestrutura de produção.
- **Escopo opcional:** IdP, dashboard, tracing e carga não foram implementados. Os endpoints financeiros permanecem abertos por decisão explícita.

## Reproduzir a validação

```powershell
bun run infra:up
bun run typecheck
bun run build
bun test --timeout 30000
```

Os testes usam bancos e filas temporários. A revisão não altera o banco financeiro de desenvolvimento e não inclui merge, commit ou push automático.
