import { createHash } from 'node:crypto';
import { ApplicationError } from './application-error';
import { encodeLedgerCursor, identifier, parseLedgerPage, parseTransaction, parseWallet, uuid } from './contracts';
import type { FinancialDiagnostics, FinancialSession, FinancialStore } from './financial-store';
import { hashTransactionPayload } from './transaction-payload';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed,
  WagerTransactionRejected, type EventContext } from './integration-events';

export class FinancialService {
  constructor(private readonly store: FinancialStore, private readonly diagnostics: FinancialDiagnostics) {}

  async createWallet(input: unknown, ctx: EventContext) {
    const props = parseWallet(input);
    const id = crypto.randomUUID();
    const openingHash = createHash('sha256').update(JSON.stringify(props)).digest('hex');
    const opened = Wallet.open({ id, playerId: props.playerId, initialBalance: Money.from(props.initialBalance),
      at: new Date(), opening: { transactionId: crypto.randomUUID(), ledgerId: crypto.randomUUID(), payloadHash: openingHash } });
    return this.store.transaction(async session => {
      await session.insertWallet(opened.wallet);
      if (opened.transaction && opened.entry) {
        await session.insertTransaction(opened.transaction);
        await session.insertLedger(opened.entry);
        await session.enqueue(WagerTransactionProcessed.from(opened.transaction, ctx));
        await session.enqueue(WalletBalanceChanged.from(opened.entry, ctx));
      }
      return this.walletResponse(opened.wallet);
    });
  }

  async submit(input: unknown, keyInput: unknown, ctx: EventContext) {
    const payload = parseTransaction(input);
    const key = identifier(keyInput);
    const hash = hashTransactionPayload(payload);
    // Valida o comando antes de adquirir recursos do banco.
    const props = { ...payload, id: crypto.randomUUID(), idempotencyKey: key, payloadHash: hash,
      money: Money.from(payload.money), createdAt: new Date() };
    WagerTransaction.create(props);
    const replay = (tx: WagerTransaction) => {
      if (tx.idempotencyKey !== key) throw new ApplicationError('CONFLICT', 'EXTERNAL_TRANSACTION_CONFLICT');
      tx.assertPayload(hash);
      return this.transactionResponse(tx, true);
    };
    try {
      return await this.store.transaction(async session => {
        const prior = await session.byKey(key);
        if (prior) return replay(prior);
        const wallet = await session.findWallet(payload.walletId, true);
        if (!wallet) throw new ApplicationError('NOT_FOUND', 'WALLET_NOT_FOUND');
        // O lock pode ter aguardado outra instância; releia a chave após adquiri-lo.
        const duplicate = await session.byKey(key) ?? await session.byExternal(payload.providerId, payload.externalTransactionId);
        if (duplicate) return replay(duplicate);
        const tx = WagerTransaction.create(props);
        const reference = payload.referenceExternalTransactionId
          ? await session.byExternal(payload.providerId, payload.referenceExternalTransactionId) : null;
        const reversed = reference && tx.requiresReference() ? await session.hasReversal(reference.id) : false;
        const entry = wallet.apply(tx, { at: new Date(), ledgerId: crypto.randomUUID(),
          reference: reference ?? undefined, alreadyReversed: reversed });
        await session.insertTransaction(tx);
        if (entry) {
          await session.insertLedger(entry);
          await session.updateWallet(wallet);
          await session.enqueue(WalletBalanceChanged.from(entry, ctx));
        }
        if (tx.status === 'PROCESSED') await session.enqueue(WagerTransactionProcessed.from(tx, ctx));
        else if (tx.status === 'REJECTED') await session.enqueue(WagerTransactionRejected.from(tx, ctx));
        else await session.enqueue(WagerTransactionPendingReference.from(tx, ctx));
        return this.transactionResponse(tx, false);
      });
    } catch (error) {
      // Chaves globais podem colidir mesmo quando as wallets são diferentes.
      if (!(error instanceof ApplicationError) || error.code !== 'CONFLICT') throw error;
      return this.store.transaction(async session => {
        const existing = await session.byKey(key) ?? await session.byExternal(payload.providerId, payload.externalTransactionId);
        if (existing) return replay(existing);
        throw error;
      });
    }
  }

  async getWallet(idInput: unknown) {
    const id = uuid(idInput);
    return this.store.transaction(async session => this.walletResponse(await this.requireWallet(session, id)));
  }
  async getTransaction(idInput: unknown) {
    const id = uuid(idInput);
    return this.store.transaction(async session => {
      const tx = await session.byId(id);
      if (!tx) throw new ApplicationError('NOT_FOUND', 'TRANSACTION_NOT_FOUND');
      return this.transactionDetails(tx);
    });
  }
  async getExternal(providerInput: unknown, externalInput: unknown) {
    const provider = identifier(providerInput); const external = identifier(externalInput);
    return this.store.transaction(async session => {
      const tx = await session.byExternal(provider, external);
      if (!tx) throw new ApplicationError('NOT_FOUND', 'TRANSACTION_NOT_FOUND');
      return this.transactionDetails(tx);
    });
  }
  async getLedger(idInput: unknown, cursor: unknown, limit: unknown) {
    const id = uuid(idInput); const page = parseLedgerPage(id, cursor, limit);
    return this.store.transaction(async session => {
      await this.requireWallet(session, id);
      const entries = await session.ledger(id, page.version, page.limit + 1);
      const items = entries.slice(0, page.limit);
      return { items: items.map(entry => ({ id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
        direction: entry.direction, money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(), walletVersion: entry.walletVersion, createdAt: entry.createdAt.toISOString() })),
        nextCursor: entries.length > page.limit
          ? encodeLedgerCursor({ walletId: id, version: items.at(-1)!.walletVersion }) : null };
    });
  }
  async reconcile(idInput: unknown, ctx: EventContext) {
    const id = uuid(idInput);
    return this.store.transaction(async session => {
      // O mesmo lock das escritas evita comparar saldo e ledger de instantes distintos.
      const wallet = await this.requireWallet(session, id, true);
      const sum = await session.reconcile(id);
      const calculated = Money.rehydrate({ amount: sum.amount, currency: wallet.currency });
      const difference = wallet.balance.subtract(calculated);
      if (!difference.isZero()) this.diagnostics.reconciliationMismatch(id, ctx.correlationId);
      return { walletId: id, storedBalance: wallet.balance.toJSON(), calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(), consistent: difference.isZero(), checkedEntries: sum.count };
    });
  }
  private async requireWallet(session: FinancialSession, id: string, lock = false) {
    const wallet = await session.findWallet(id, lock);
    if (!wallet) throw new ApplicationError('NOT_FOUND', 'WALLET_NOT_FOUND');
    return wallet;
  }
  private walletResponse(wallet: Wallet) {
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
  private transactionResponse(tx: WagerTransaction, replay: boolean) {
    return { transactionId: tx.id, status: tx.status, balance: tx.resultBalance?.toJSON() ?? null,
      failureCode: tx.failureCode ?? null, idempotentReplay: replay };
  }
  private transactionDetails(tx: WagerTransaction) {
    return { ...this.transactionResponse(tx, false), providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId, walletId: tx.walletId, playerId: tx.playerId,
      roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind, money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      createdAt: tx.createdAt.toISOString(), processedAt: tx.processedAt?.toISOString() ?? null };
  }
}
