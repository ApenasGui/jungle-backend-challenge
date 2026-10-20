# Decisões de arquitetura

## Estado atual e organização

O domínio financeiro, os mapeamentos TypeORM, a migration e a API financeira estão implementados. Casos de uso dependem da porta `FinancialStore`, sem importar NestJS ou TypeORM. O adaptador fornece uma sessão com o mesmo `EntityManager` para cada transação. A migration foi aplicada no PostgreSQL 17.6 e validada com rollback/reaplicação. Workers SQS, publicação da outbox, readiness e observabilidade completa continuam pendentes.

NestJS organiza HTTP e injeção de dependências. Bun 1.4.3 executa aplicação, instalação e testes; TypeScript verifica tipos e compila o código. TypeORM foi escolhido por familiaridade do candidato. Usamos `EntitySchema` para manter o domínio sem decorators ou dependências do ORM. Mappers explícitos reconstroem as classes pelas factories `rehydrate`, sem reaplicar transições.

As migrations são a fonte da verdade do schema, incluindo triggers e índices parciais. `synchronize` e migrations automáticas estão desabilitados. A migration inicial tem `up` e `down`; seu `down` descarta as tabelas criadas e os respectivos dados.

## Dinheiro

`Money` usa uma configuração isolada de decimal.js com precisão de 50 dígitos. A persistência usa `NUMERIC(20,2)`, recebido do driver como string. Não existe conversão de dinheiro para `number`.

O contrato exige formato canônico: `0.00` ou parte inteira sem zeros à esquerda seguida de exatamente duas casas. `1`, `1.0`, `01.00`, sinais, espaços, notação científica e casas excedentes são inválidos. Não há arredondamento silencioso. A magnitude máxima é `999999999999999999.99`; overflow falha explicitamente. Diferenças internas podem ser negativas, mas entradas externas e saldos não podem.

O modelo mantém moeda em cada valor. O escopo aceita BRL e USD para permitir testes reais de conflito; outras moedas exigem ampliação explícita da lista e da constraint. Operações entre moedas diferentes são erros.

## Transações e ledger

As factories têm construtores privados. `Wallet.apply` valida a operação, cria o lançamento, marca a transação e então altera a wallet em memória. Isso não substitui uma transação SQL. A abertura positiva devolve wallet, transação interna `OPENING` e crédito no ledger; a abertura zero não gera transação nem ledger. A versão inicial é 1 e só aumenta quando o saldo muda.

O resultado guarda o saldo observado e sua moeda, inclusive nas rejeições por moeda incompatível. O caso de uso consulta o registro persistido antes de executar e novamente após adquirir o lock. Replay devolve o saldo original sem gerar novo ledger ou evento. A mesma chave com payload diferente retorna conflito; o mesmo ID externo com outra chave também é conflito, pois o header é a fonte da verdade.

| Origem | Transições válidas |
| --- | --- |
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED`, `REJECTED`, `FAILED` | Nenhuma |

`processedAt` registra conclusão em qualquer estado terminal. Reaplicar transação terminal é erro de programação; o caso de uso deve detectar replay antes de chamar o domínio.

Interpretações adotadas para pontos abertos do enunciado:

- `LOSS` exige `0.00`; demais operações exigem valor positivo. Isso evita lançamentos sem efeito e incrementos artificiais de versão.
- `WIN` e `LOSS` podem referenciar uma `BET`; quando informada, a referência deve respeitar as mesmas regras de identidade e pode gerar espera. `BET` não aceita referência.
- `REFUND` só reverte `BET`; `ROLLBACK` só reverte `BET`, `WIN` ou `REFUND`, integralmente.
- Uma transação pode sofrer uma única reversão processada, independentemente de ser `REFUND` ou `ROLLBACK`. O enunciado exige unicidade por tipo; adotamos proteção adicional contra usar os dois tipos para creditar a mesma aposta duas vezes. Um `ROLLBACK` do próprio `REFUND` continua permitido, porque referencia outra transação.
- Referência ainda pendente continua aguardando. Referência terminal sem sucesso causa rejeição. Identidade divergente é rejeitada mesmo que a referência esteja pendente.
- A comparação de referência usa provedor, jogador, wallet, moeda e rodada. `gameId` não entra nessa comparação, conforme os campos explicitamente exigidos.

## Proteções escritas no schema

- Unicidade de wallet por jogador/moeda, chave de idempotência global e ID externo por provedor.
- Um lançamento por transação/wallet, uma posição por versão e um `OPENING` por wallet.
- Índice parcial impede mais de uma reversão processada da mesma referência.
- Checks de saldo não negativo, valores finitos, aritmética, tipos e coerência dos estados.
- Chaves estrangeiras compostas vinculam moeda e wallet do ledger às entidades correspondentes.
- Triggers bloqueiam alteração, exclusão e truncamento do ledger; protegem payload e estados terminais das transações; preservam a identidade da wallet.
- A inserção no ledger trava apenas sua wallet e verifica continuidade de saldo e versão com o lançamento anterior.
- Triggers diferidos verificam no commit se a wallet coincide com o último lançamento e se toda transação financeira processada tem seu lançamento correto. `LOSS` e transações não processadas não podem ter lançamentos.

A cadeia validada em cada inserção permite consultar o último lançamento por índice, sem somar todo o histórico a cada escrita. O endpoint de reconciliação soma o histórico de forma independente, sob lock da wallet para comparar dados do mesmo instante. Divergências são sinalizadas, logadas sem valores financeiros e contabilizadas em uma métrica por processo. Não há correção automática. Testes PostgreSQL e três processos HTTP confirmaram consistência dos cenários exercitados. Os triggers não protegem contra um administrador que remova ou desabilite deliberadamente as constraints.

## Estratégia transacional

O caso de uso adquire `SELECT ... FOR UPDATE` na wallet antes de calcular o saldo, em `READ COMMITTED`. Wallets diferentes podem prosseguir em paralelo. Transação, wallet, ledger e outbox usam o mesmo `EntityManager` transacional. A inbox será integrada quando houver entrada SQS. Eventos são gravados na outbox; ainda não há publisher.

Constraints únicas garantem idempotência entre processos. Uma colisão global de chave pode ocorrer entre wallets diferentes; a transação perdedora é revertida e o caso de uso busca o resultado persistido para comparar o hash. Resolução de referência e verificação de reversão ocorrem sob o lock da wallet.

O adaptador limita espera por lock a 3 segundos e cada comando SQL a 10 segundos. Repete até duas vezes após deadlock, falha de serialização ou timeout de lock, sempre abrindo nova transação e recarregando o estado. Não repete automaticamente falha de conexão com resultado de commit incerto: responde `503`, permitindo que o cliente consulte ou repita a mesma chave com segurança.

O schema reserva inbox com chave `(consumerName, messageId)` e outbox com índice de publicação pendente. Os quatro eventos exigidos possuem subclasses concretas de um envelope abstrato com ID, versão, correlação e valores monetários serializados. Abertura positiva emite evento de transação processada e de saldo alterado; `LOSS` e rejeições não emitem mudança de saldo. Replay não emite novos eventos.

Referências ausentes recebem agendamento inicial em 1 segundo e expiração em 24 horas. Esses campos preparam o worker futuro; ainda não há reprocessamento nem aplicação automática do TTL. O Compose configura filas FIFO de entrada, DLQ e saída; deduplicação do broker será uma otimização, não a garantia financeira.

## Hash de payload

SHA-256 de JSON canônico com chaves ordenadas recursivamente. Inclui apenas `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e referência quando presente. Campos ausentes são omitidos. Header de idempotência e metadados de transporte não entram. A validação do contrato deve preceder o hash.

## Códigos de falha

| Código | Significado |
| --- | --- |
| `INVALID_MONEY` | Formato ou moeda não suportados |
| `CURRENCY_MISMATCH` | Moedas incompatíveis |
| `AMOUNT_OUT_OF_RANGE` | Limite monetário excedido |
| `INVALID_TRANSACTION` | Contrato ou combinação de campos inválidos |
| `INSUFFICIENT_FUNDS` | Aposta sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão produziria saldo negativo |
| `WALLET_MISMATCH` | Wallet ou jogador incompatíveis |
| `REFERENCE_NOT_FOUND` | Referência não resolvida até o futuro limite de tentativas/TTL |
| `REFERENCE_NOT_PROCESSED` | Referência concluída sem sucesso |
| `REFERENCE_MISMATCH` | Identidade da referência divergente |
| `INVALID_REFERENCE_KIND` | Tipo de referência inválido |
| `REVERSAL_AMOUNT_MISMATCH` | Reversão com valor diferente da referência |
| `ALREADY_REVERSED` | Referência já revertida |
| `IDEMPOTENCY_CONFLICT` | Payload difere do registrado |
| `INFRASTRUCTURE_FAILURE` | Falha permanente de infraestrutura |
| `INVALID_TRANSACTION_STATE`, `INVALID_LEDGER` | Violação interna de transição ou lançamento |

O mapeamento HTTP separa `400` (entrada inválida), `404` (recurso ausente), `409` (conflito), `422` (rejeição de negócio), `202` (pendente), `503` (falha transitória) e `500` (erro interno). Consultas bem-sucedidas retornam `200`, mesmo quando o estado consultado é rejeitado. Os contratos são validados no caso de uso para que a futura fila utilize as mesmas regras. Erros internos não expõem SQL nem payloads financeiros.

O ledger usa cursor opaco contendo wallet e versão. A versão é imutável e estritamente crescente, evitando problemas com timestamps iguais ou precisão de datas. Limite de página: 1 a 100. O cursor não é uma credencial de autorização.

## Validação e pendências

Os testes unitários verificam dinheiro, operações, rejeições, referências, estados terminais, hash, snapshots e mapeamentos. A validação de metadados TypeORM não abre conexão. O teste sequencial de duas apostas verifica a regra de saldo, mas não comprova concorrência real.

Os 63 testes de integração/HTTP usam PostgreSQL 17.6 e LocalStack 4.7.0 reais. Verificam migrations, constraints, ledger, referências, unicidade da inbox, atomicidade SQL, contratos, replay, paginação e erros. Uma falha injetada na inserção da outbox confirma que o endpoint não deixa débito parcial. Depois de cada teste financeiro, a suíte reconstrói o saldo somando o ledger. Cada execução cria e remove seu próprio banco. O teste de SQS verifica apenas existência das filas, FIFO e política de DLQ.

A execução real identificou e corrigiu uma expressão `CASE` que precisava de parênteses dentro do `IF` de um trigger. Também confirmou que `Infinity` falha no próprio `NUMERIC(20,2)` com SQLSTATE `22003`, enquanto `NaN` é recusado pelo check com `23514`.

Cinco testes de concorrência iniciam três processos reais: 50 duplicatas causam um débito; duas apostas de 80 disputam saldo 100; chave global entre wallets não duplica efeitos; um lock não bloqueia outra wallet; replay permanece seguro após reiniciar um processo. Os processos são encerrados e o banco temporário é removido.

Faltam processamento SQS, publishers concorrentes, reprocessamento de referências e seus testes de retry, DLQ e falhas após commit/antes do ack. Readiness, logs de processamento completos, métricas adicionais e shutdown dos workers também estão pendentes. Os logs de bootstrap já usam JSON e a reconciliação possui uma métrica Prometheus, mas isso ainda não cobre toda a observabilidade exigida.

## Autenticação

A proposta é adiar a integração com IdP e documentar o ponto de extensão, priorizando os requisitos financeiros. Essa decisão ainda deve ser confirmada com o candidato; nenhum mecanismo de autenticação foi implementado nesta etapa.
