-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 010: CARTEIRAS E LIVRO-RAZÃO EM PARTIDAS DOBRADAS
-- ==============================================================================

-- 1. Tipos enumerados para o sistema financeiro, carteiras e contabilidade
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_status') THEN
        CREATE TYPE wallet_status AS ENUM (
            'ACTIVE',    -- Carteira plenamente operacional
            'FROZEN',    -- Bloqueada preventivamente por suspeita ou contestação
            'SUSPENDED', -- Suspensa por restrição administrativa ou judicial
            'CLOSED'     -- Encerrada após liquidação total
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_account_type') THEN
        CREATE TYPE ledger_account_type AS ENUM (
            'ASSET',     -- Ativo (ex: Conta de Custódia em Banco Parceiro)
            'LIABILITY', -- Passivo (ex: Saldos devidos aos Utilizadores)
            'EQUITY',    -- Patrimônio Líquido
            'REVENUE',   -- Receita (ex: Comissões e Taxas da Plataforma)
            'EXPENSE'    -- Despesa (ex: Custos operacionais de Gateways)
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_entry_direction') THEN
        CREATE TYPE ledger_entry_direction AS ENUM (
            'DEBIT',  -- Débito
            'CREDIT'  -- Crédito
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_transaction_status') THEN
        CREATE TYPE ledger_transaction_status AS ENUM (
            'PENDING', -- Em fase de preparação atómica
            'POSTED',  -- Lançada e consolidada de forma imutável
            'VOIDED',  -- Anulada antes da consolidação
            'REVERSED' -- Estornada por lançamento compensatório auditado
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'financial_operation_type') THEN
        CREATE TYPE financial_operation_type AS ENUM (
            'DEPOSIT',
            'WITHDRAWAL',
            'INTERNAL_TRANSFER',
            'CONTRIBUTION_PAYMENT',
            'ROTATION_PAYOUT',
            'PLATFORM_FEE',
            'LATE_PENALTY',
            'REFUND_REVERSAL',
            'DISPUTE_HOLD',
            'DISPUTE_RELEASE'
        );
    END IF;
END $$;

-- 2. Tabela de carteiras dos utilizadores
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status wallet_status NOT NULL DEFAULT 'ACTIVE',
    ledger_balance BIGINT NOT NULL DEFAULT 0,    -- Saldo total contabilístico em Kwanzas (AOA)
    available_balance BIGINT NOT NULL DEFAULT 0, -- Saldo imediatamente disponível para movimentação
    locked_balance BIGINT NOT NULL DEFAULT 0,    -- Fundos retidos temporariamente (ordens ou garantias)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_wallet_positive_balances CHECK (ledger_balance >= 0 AND available_balance >= 0 AND locked_balance >= 0),
    CONSTRAINT chk_wallet_balance_integrity CHECK (available_balance + locked_balance = ledger_balance)
);

CREATE TRIGGER trg_wallets_updated_at
BEFORE UPDATE ON wallets
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de contas contábeis do plano de contas oficial
CREATE TABLE IF NOT EXISTS ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    account_type ledger_account_type NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    wallet_id UUID REFERENCES wallets(id) ON DELETE RESTRICT,
    balance BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_ledger_accounts_updated_at
BEFORE UPDATE ON ledger_accounts
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 4. Tabela de transações contábeis do livro-razão (Cabeçalho de lançamentos imutáveis)
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_code VARCHAR(64) NOT NULL UNIQUE,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    operation_type financial_operation_type NOT NULL,
    status ledger_transaction_status NOT NULL DEFAULT 'POSTED',
    amount BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    description VARCHAR(255) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    related_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    posted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_ledger_tx_positive_amount CHECK (amount > 0)
);

-- 5. Tabela de lançamentos contábeis em partidas dobradas (Pernas de Débito e Crédito)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    direction ledger_entry_direction NOT NULL,
    amount BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    sequence INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_entry_amount_positive CHECK (amount > 0),
    CONSTRAINT uq_tx_account_direction_sequence UNIQUE (transaction_id, account_id, direction, sequence)
);