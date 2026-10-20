import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialFinancialSchema1792440000000 implements MigrationInterface {
  name = 'InitialFinancialSchema1792440000000';

  // As constraints protegem as invariantes mesmo quando a escrita não vem da API.
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency varchar(3) NOT NULL CHECK (currency IN ('BRL', 'USD')),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0 AND balance < 'Infinity'::numeric),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency),
        UNIQUE (id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(200) NOT NULL CHECK (length(trim(provider_id)) > 0),
        external_transaction_id varchar(200) NOT NULL CHECK (length(trim(external_transaction_id)) > 0),
        idempotency_key varchar(200) NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
        payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id uuid NOT NULL,
        round_id varchar(200) NOT NULL CHECK (length(trim(round_id)) > 0),
        game_id varchar(200) NOT NULL CHECK (length(trim(game_id)) > 0),
        kind varchar(10) NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0 AND amount < 'Infinity'::numeric),
        currency varchar(3) NOT NULL CHECK (currency IN ('BRL','USD')),
        status varchar(20) NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id varchar(200),
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        failure_code varchar(80),
        result_balance numeric(20,2),
        result_currency varchar(3),
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        reference_expires_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        UNIQUE (id, wallet_id, currency),
        CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (kind NOT IN ('OPENING','BET') OR reference_external_transaction_id IS NULL),
        CHECK (reference_external_transaction_id IS NULL OR
          (length(trim(reference_external_transaction_id)) > 0 AND reference_external_transaction_id <> external_transaction_id)),
        CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
        CHECK (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL),
        CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK (failure_code IS NULL OR length(trim(failure_code)) > 0),
        CHECK (status <> 'PROCESSED' OR (result_balance IS NOT NULL AND result_currency = currency)),
        CHECK (status <> 'PROCESSED' OR ((reference_external_transaction_id IS NOT NULL) = (reference_transaction_id IS NOT NULL))),
        CHECK ((result_balance IS NULL) = (result_currency IS NULL)),
        CHECK (result_balance IS NULL OR (result_balance >= 0 AND result_balance < 'Infinity'::numeric)),
        CHECK (result_currency IS NULL OR result_currency IN ('BRL','USD'))
      );

      -- Impede também REFUND e ROLLBACK de devolverem a mesma BET duas vezes.
      CREATE UNIQUE INDEX one_processed_reversal ON wager_transactions(reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE UNIQUE INDEX one_wallet_opening ON wager_transactions(wallet_id) WHERE kind = 'OPENING';
      CREATE INDEX pending_reference_due ON wager_transactions(next_reference_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE';
      CREATE INDEX wallet_transactions ON wager_transactions(wallet_id, created_at, id);

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction varchar(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0 AND amount < 'Infinity'::numeric),
        currency varchar(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0 AND balance_before < 'Infinity'::numeric),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0 AND balance_after < 'Infinity'::numeric),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL,
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        UNIQUE (transaction_id, wallet_id),
        UNIQUE (wallet_id, wallet_version),
        CHECK (balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_cursor ON wallet_ledger_entries(wallet_id, created_at, id);

      CREATE TABLE inbox_messages (
        consumer_name varchar(200) NOT NULL,
        message_id varchar(200) NOT NULL,
        payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type varchar(100) NOT NULL,
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz
      );
      CREATE INDEX outbox_due ON outbox_messages(next_attempt_at, id) WHERE published_at IS NULL;

      CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger is append-only' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

      CREATE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'transaction history cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['status','reference_transaction_id','failure_code','result_balance','result_currency',
            'reference_attempts','next_reference_attempt_at','reference_expires_at','processed_at'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','reference_transaction_id','failure_code','result_balance','result_currency',
            'reference_attempts','next_reference_attempt_at','reference_expires_at','processed_at']) THEN
          RAISE EXCEPTION 'transaction payload is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid transaction transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER transaction_history BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_transaction();

      CREATE FUNCTION protect_wallet_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallet_identity BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION protect_wallet_identity();

      -- O lock é local à wallet. O caso de uso deverá adquiri-lo antes de calcular o saldo.
      CREATE FUNCTION validate_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous wallet_ledger_entries%ROWTYPE; operation_kind text;
      BEGIN
        PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        SELECT * INTO previous FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id
          ORDER BY wallet_version DESC LIMIT 1;
        SELECT kind INTO operation_kind FROM wager_transactions WHERE id = NEW.transaction_id;
        IF previous.id IS NULL THEN
          IF NEW.balance_before <> 0 OR NEW.wallet_version <> (CASE WHEN operation_kind = 'OPENING' THEN 1 ELSE 2 END) THEN
            RAISE EXCEPTION 'invalid first ledger entry' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.balance_before <> previous.balance_after OR NEW.wallet_version <> previous.wallet_version + 1
          OR operation_kind = 'OPENING' THEN
          RAISE EXCEPTION 'broken ledger chain' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ledger_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION validate_ledger_chain();

      -- A verificação no commit permite gravar wallet e ledger em qualquer ordem.
      CREATE FUNCTION verify_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wallet_key uuid; wallet_row wallets%ROWTYPE; last_entry wallet_ledger_entries%ROWTYPE;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wallet_key := NEW.id; ELSE wallet_key := NEW.wallet_id; END IF;
        SELECT * INTO wallet_row FROM wallets WHERE id = wallet_key;
        SELECT * INTO last_entry FROM wallet_ledger_entries WHERE wallet_id = wallet_key
          ORDER BY wallet_version DESC LIMIT 1;
        IF last_entry.id IS NULL THEN
          IF wallet_row.balance <> 0 OR wallet_row.version <> 1 THEN
            RAISE EXCEPTION 'wallet without matching ledger' USING ERRCODE = '23514';
          END IF;
        ELSIF wallet_row.balance <> last_entry.balance_after OR wallet_row.version <> last_entry.wallet_version THEN
          RAISE EXCEPTION 'wallet and ledger disagree' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_matches_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();
      CREATE CONSTRAINT TRIGGER ledger_matches_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();

      CREATE FUNCTION verify_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE transaction_key uuid; tx wager_transactions%ROWTYPE; ref wager_transactions%ROWTYPE;
        entry wallet_ledger_entries%ROWTYPE; owner_wallet wallets%ROWTYPE; expected_direction text;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN transaction_key := NEW.id;
        ELSE transaction_key := NEW.transaction_id; END IF;
        SELECT * INTO tx FROM wager_transactions WHERE id = transaction_key;
        SELECT * INTO entry FROM wallet_ledger_entries WHERE transaction_id = transaction_key;
        IF tx.status = 'PROCESSED' THEN
          SELECT * INTO owner_wallet FROM wallets WHERE id = tx.wallet_id;
          IF tx.player_id <> owner_wallet.player_id OR tx.currency <> owner_wallet.currency THEN
            RAISE EXCEPTION 'processed wallet mismatch' USING ERRCODE = '23514';
          END IF;
          IF tx.reference_transaction_id IS NOT NULL THEN
            SELECT * INTO ref FROM wager_transactions WHERE id = tx.reference_transaction_id;
            IF ref.status <> 'PROCESSED' OR ref.provider_id <> tx.provider_id OR ref.wallet_id <> tx.wallet_id
              OR ref.player_id <> tx.player_id OR ref.currency <> tx.currency OR ref.round_id <> tx.round_id
              OR ref.external_transaction_id <> tx.reference_external_transaction_id
              OR (tx.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND'))
              OR (tx.kind <> 'ROLLBACK' AND ref.kind <> 'BET')
              OR (tx.kind IN ('REFUND','ROLLBACK') AND tx.amount <> ref.amount) THEN
              RAISE EXCEPTION 'invalid processed reference' USING ERRCODE = '23514';
            END IF;
          END IF;
          IF tx.kind <> 'LOSS' THEN
            expected_direction := CASE WHEN tx.kind = 'BET' OR (tx.kind = 'ROLLBACK' AND ref.kind IN ('WIN','REFUND'))
              THEN 'DEBIT' ELSE 'CREDIT' END;
            IF entry.id IS NULL OR entry.amount <> tx.amount OR entry.direction <> expected_direction
              OR entry.balance_after <> tx.result_balance THEN
              RAISE EXCEPTION 'transaction without matching ledger' USING ERRCODE = '23514';
            END IF;
          ELSIF entry.id IS NOT NULL THEN
            RAISE EXCEPTION 'LOSS cannot have ledger' USING ERRCODE = '23514';
          END IF;
        ELSIF entry.id IS NOT NULL THEN
          RAISE EXCEPTION 'unprocessed transaction cannot have ledger' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER transaction_matches_ledger AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_matches_transaction AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_ledger();
    `);
  }

  // Reverte a estrutura inteira; executar down descarta os dados destas tabelas.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets;
      DROP FUNCTION verify_transaction_ledger(), verify_wallet_ledger(), validate_ledger_chain(),
        protect_transaction(), prevent_ledger_mutation(), protect_wallet_identity();
    `);
  }
}
