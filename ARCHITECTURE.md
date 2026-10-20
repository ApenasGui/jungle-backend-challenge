# Decisões de arquitetura

## Estado atual e organização

O domínio financeiro, os mapeamentos TypeORM, a migration, a API financeira e os workers estão implementados. Casos de uso dependem da porta `FinancialStore`, sem importar NestJS ou TypeORM. O adaptador fornece uma sessão com o mesmo `EntityManager` para cada transação. A migration foi aplicada no PostgreSQL 17.6 e validada com rollback/reaplicação. Readiness, métricas Prometheus e logs JSON correlacionados estão implementados.

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

O caso de uso adquire `SELECT ... FOR UPDATE` na wallet antes de calcular o saldo, em `READ COMMITTED`. Wallets diferentes podem prosseguir em paralelo. Inbox, transação, wallet, ledger e outbox usam o mesmo `EntityManager` transacional. O consumidor SQS chama o mesmo caso de uso da API e confirma a mensagem somente após o commit.

Constraints únicas garantem idempotência entre processos. Uma colisão global de chave pode ocorrer entre wallets diferentes; a transação perdedora é revertida e o caso de uso busca o resultado persistido para comparar o hash. Resolução de referência e verificação de reversão ocorrem sob o lock da wallet.

O adaptador limita espera por lock a 3 segundos e cada comando SQL a 10 segundos. Repete até duas vezes após deadlock, falha de serialização ou timeout de lock, sempre abrindo nova transação e recarregando o estado. Não repete automaticamente falha de conexão com resultado de commit incerto: responde `503`, permitindo que o cliente consulte ou repita a mesma chave com segurança.

O schema mantém inbox com chave `(consumerName, messageId)` e outbox com índice de publicação pendente. Os eventos possuem subclasses concretas de um envelope abstrato com ID, versão, correlação e valores monetários serializados. Abertura positiva emite evento de transação processada e de saldo alterado; `LOSS` e rejeições não emitem mudança de saldo. Replay não emite novos eventos.

Referências ausentes recebem agendamento inicial em 1 segundo e expiração em 24 horas. O worker busca lotes de 20 e revalida estado e agendamento sob lock da wallet. O backoff cresce exponencialmente até 15 minutos. Após 100 tentativas ou expiração, a transação é rejeitada com `REFERENCE_NOT_FOUND`. Duas instâncias podem buscar a mesma candidata, mas apenas uma aplica a transição. O Compose configura filas FIFO de entrada, DLQ e saída; a deduplicação do broker é uma otimização, não a garantia financeira.

## Mensageria e recuperação

A inbox trava sua identidade e compara o hash do payload financeiro mais a chave de idempotência. Metadados de transporte não alteram esse hash. Redelivery após commit encontra o resultado persistido e não repete ledger nem eventos. Se qualquer escrita falhar, a inbox também é revertida.

O consumidor usa long polling de 20 segundos e renova a visibilidade durante o processamento. Falhas transitórias aguardam backoff exponencial, limitado a 300 segundos, até cinco recebimentos. Payload inválido ou conflito segue diretamente para a DLQ. A mensagem original só é removida depois da confirmação do envio à DLQ; uma falha nesse envio preserva a possibilidade de redelivery. Rejeições comerciais recebem ack normal.

Ao esgotar retries de infraestrutura, o consumidor tenta registrar `FAILED` e `WagerTransactionFailed`, sem alterar saldo nem sobrescrever resultado existente. Se o banco continuar indisponível, essa auditoria SQL não pode ser garantida: a mensagem preservada na DLQ é o registro durável para investigação e reprocessamento operacional. Não há redrive automático da DLQ.

Cada publisher reserva uma linha da outbox com `FOR UPDATE SKIP LOCKED` e `LIMIT 1`, envia o evento e marca a publicação na mesma transação SQL. Falha de envio persiste tentativas e backoff até 60 segundos. Uma queda após envio e antes do commit pode repetir o evento; `eventId` permanece estável e deve ser deduplicado pelo consumidor. O FIFO usa wallet como grupo, mas publishers concorrentes não garantem ordem global de publicação; consumidores devem considerar a versão financeira dos eventos de saldo.

`SIGINT` e `SIGTERM` interrompem novos recebimentos e aguardam o trabalho em andamento antes de fechar conexões. Os workers expõem métricas por processo na porta 3001 e logs JSON com identificadores, sem payload financeiro. Os testes encerram processos reais nos intervalos commit/ack e envio/marcação e verificam recuperação por outra instância.

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
| `REFERENCE_NOT_FOUND` | Referência não resolvida até o limite de tentativas/TTL |
| `REFERENCE_NOT_PROCESSED` | Referência concluída sem sucesso |
| `REFERENCE_MISMATCH` | Identidade da referência divergente |
| `INVALID_REFERENCE_KIND` | Tipo de referência inválido |
| `REVERSAL_AMOUNT_MISMATCH` | Reversão com valor diferente da referência |
| `ALREADY_REVERSED` | Referência já revertida |
| `IDEMPOTENCY_CONFLICT` | Payload difere do registrado |
| `INFRASTRUCTURE_FAILURE` | Falha permanente de infraestrutura |
| `INVALID_TRANSACTION_STATE`, `INVALID_LEDGER` | Violação interna de transição ou lançamento |

O mapeamento HTTP separa `400` (entrada inválida), `404` (recurso ausente), `409` (conflito), `422` (rejeição de negócio), `202` (pendente), `503` (falha transitória) e `500` (erro interno). Consultas bem-sucedidas retornam `200`, mesmo quando o estado consultado é rejeitado. Os contratos são validados no caso de uso para que HTTP e fila utilizem as mesmas regras. Erros internos não expõem SQL nem payloads financeiros.

O ledger usa cursor opaco contendo wallet e versão. A versão é imutável e estritamente crescente, evitando problemas com timestamps iguais ou precisão de datas. Limite de página: 1 a 100. O cursor não é uma credencial de autorização.

## Validação e pendências

Os testes unitários verificam dinheiro, operações, rejeições, referências, estados terminais, hash, snapshots e mapeamentos. A validação de metadados TypeORM não abre conexão. O teste sequencial de duas apostas verifica a regra de saldo, mas não comprova concorrência real.

Os 91 testes de integração/HTTP/mensageria/observabilidade usam PostgreSQL 17.6 e LocalStack 4.7.0 reais. Verificam migrations, constraints, ledger, referências, unicidade da inbox, atomicidade SQL, contratos, replay, paginação e erros. Uma falha injetada na inserção da outbox confirma que o endpoint não deixa débito parcial. Depois de cada teste financeiro, a suíte reconstrói o saldo somando o ledger. Cada execução cria e remove seu próprio banco. A mensageria usa filas temporárias e cobre retry, DLQ, publishers concorrentes, TTL, falhas de processos e shutdown.

A execução real identificou e corrigiu uma expressão `CASE` que precisava de parênteses dentro do `IF` de um trigger. Também confirmou que `Infinity` falha no próprio `NUMERIC(20,2)` com SQLSTATE `22003`, enquanto `NaN` é recusado pelo check com `23514`.

Cinco testes de concorrência iniciam três processos reais: 50 duplicatas causam um débito; duas apostas de 80 disputam saldo 100; chave global entre wallets não duplica efeitos; um lock não bloqueia outra wallet; replay permanece seguro após reiniciar um processo. Os processos são encerrados e o banco temporário é removido.

A validação de observabilidade cobre readiness com banco indisponível e fila ausente, liveness independente das dependências, correlação de logs e eventos, ausência de valores financeiros nos logs, backlog da outbox e conflitos reais de lock.

## Observabilidade e limites operacionais

API e worker expõem liveness e readiness separadamente. Readiness faz `SELECT 1` em conexão dedicada, com timeout de conexão e consulta de 2 segundos, e consulta atributos das três filas em paralelo, com timeout de 2 segundos por chamada. Não publica nem recebe mensagens. Durante shutdown, a aplicação deixa de indicar que aceita trabalho. Uma falha de dependência retorna apenas flags, sem credenciais ou mensagens internas.

Logs HTTP registram rota, status, duração e identificadores disponíveis. O `correlationId` é validado, devolvido no header e reutilizado pelos eventos. Logs SQS adicionam `messageId`; um request HTTP não tem esse identificador. Os logs omitem headers de autorização, chave de idempotência, corpos, saldos e valores. Health e scrape de métricas não geram logs de processamento.

Métricas de resultados e retries são contadores locais e podem perder uma atualização se o processo morrer imediatamente após o commit. Por isso, também expomos gauges de transações por estado consultando o PostgreSQL, incluindo `OPENING`. Replays contam como duplicatas e não como novos resultados. Uma referência pode passar por pendência e depois por estado terminal: os contadores de resultados não representam transações únicas. A latência usa histograma com buckets entre 10 ms e 15 s, além de `+Inf`.

Outbox lag mede a idade do evento pendente mais antigo, inclusive durante backoff, e zera quando a fila SQL esvazia. Contadores de envio à DLQ medem encaminhamentos confirmados pelo processo, não o tamanho atual da fila. Conflitos de lock incluem SQLSTATE `40P01` e `55P03`; tentativas de serialização também entram em retries. Os gauges compartilhados não devem ser somados entre réplicas.

As coletas SQL de métricas usam o pool com timeout de conexão de 5 segundos e statement timeout de 10 segundos. Uma coleta falha remove seus gauges e sinaliza `collection_success=0`, evitando expor zero como se fosse um resultado válido. A contagem por estado faz agregação sobre o histórico: para volumes grandes, precisaria de coleta periódica/cache ou agregação dedicada. Um scrape por instância a cada 15–30 segundos é suficiente para o ambiente de demonstração.

Não foram adicionados dashboard, tracing distribuído, teste de carga ou IdP. A entrega usa PostgreSQL e LocalStack locais; não foi validada em uma conta AWS real. O publisher mantém uma transação SQL aberta durante o envio, limitado a 5 segundos: isso simplifica a reserva e recuperação, com custo de conexão ocupada. Uma evolução para alto volume pode usar leases persistidos, mantendo entrega pelo menos uma vez e deduplicação por `eventId`.

## Autenticação

A integração com IdP foi deixada fora do escopo para priorizar correção financeira e recuperação distribuída dentro do prazo. O ProviderAuthGuard está aplicado ao controller financeiro e libera o acesso explicitamente; ele é um ponto de extensão, não uma proteção de segurança. Health permanece público e SQS é tratado como canal interno.

Em uma implantação autenticada, o guard validaria assinatura via JWKS, issuer, audience e expiração de um access token emitido por Keycloak ou outro IdP OIDC. Uma política de autorização associaria o principal ao providerId permitido e ao escopo de wallets, incluindo consultas e criação. O providerId informado no body não seria prova de identidade. Nenhuma tabela de senhas ou autenticação artesanal seria adicionada.
