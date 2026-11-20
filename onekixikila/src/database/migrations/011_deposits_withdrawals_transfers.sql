-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 011: DEPÓSITOS, LEVANTAMENTOS E TRANSFERÊNCIAS
-- ==============================================================================

-- 1. Tipos enumerados para o ciclo das operações de tesouraria
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deposit_status') THEN
        CREATE TYPE deposit_status AS ENUM (
            'CREATED',          -- Intenção de depósito registada
            'PENDING_PAYMENT',  -- Referência gerada e aguardando pagamento
            'PROCESSING',       -- Pagamento detetado em processamento pelo prestador
            'CONFIRMED',        -- Fundos recebidos e creditados na carteira do utilizador
            'SETTLED',          -- Liquidado com confirmação bancária irrevogável
            'FAILED',           -- Transação recusada pelo gateway
            'EXPIRED',          -- Referência expirada sem pagamento
            'CANCELLED',        -- Cancelado pelo utilizador ou sistema
            'RECONCILING',      -- Em auditoria de divergência de valor ou timestamp
            'IN_DISPUTE',       -- Alvo de contestação ou chargeback
            'REVERSED'          -- Estornado contabilmente
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'withdrawal_status') THEN
        CREATE TYPE withdrawal_status AS ENUM (
            'REQUESTED',   -- Pedido submetido e fundos reservados no locked_balance
            'APPROVED',    -- Aprovado pelas regras de conformidade e limites
            'PROCESSING',  -- Ordem de transferência bancária enviada ao prestador
            'SETTLED',     -- Transferência confirmada com sucesso na conta de destino
            'REJECTED',    -- Rejeitado por inconformidade ou suspeita de fraude
            'FAILED',      -- Falha de comunicação bancária (fundos revertidos)
            'CANCELLED',   -- Cancelado pelo utilizador antes da liquidação
            'REVERSED'     -- Devolvido pelo banco de destino
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transfer_status') THEN
        CREATE TYPE transfer_status AS ENUM (
            'PENDING',   -- Em validação e execução atómica
            'COMPLETED', -- Saldo debitado do remetente e creditado no destinatário
            'FAILED',    -- Falha de autorização ou saldo insuficiente
            'REVERSED'   -- Transferência compensada por ordem de disputa
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_destination_type') THEN
        CREATE TYPE payout_destination_type AS ENUM (
            'BANK_ACCOUNT_IBAN',       -- IBAN bancário angolano (AO06...)
            'MULTICAIXA_EXPRESS_PHONE', -- Número de telemóvel MCX
            'UNITEL_MONEY_PHONE',       -- Carteira móvel Unitel Money
            'E_KWANZA_PHONE'            -- Conta digital e-Kwanza
        );
    END IF;
END $$;

-- 2. Tabela de depósitos na carteira digital
CREATE TABLE IF NOT EXISTS deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reference_number VARCHAR(64) NOT NULL UNIQUE,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    amount BIGINT NOT NULL,     -- Valor bruto em Kwanzas (AOA)
    fee_amount BIGINT NOT NULL DEFAULT 0,
    net_amount BIGINT NOT NULL, -- Valor líquido a creditar no saldo (amount - fee_amount)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    provider VARCHAR(50) NOT NULL, -- 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'
    provider_reference VARCHAR(150),
    status deposit_status NOT NULL DEFAULT 'CREATED',
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    settled_at TIMESTAMP WITH TIME ZONE,
    ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_deposit_positive CHECK (amount > 0 AND fee_amount >= 0),
    CONSTRAINT chk_deposit_net CHECK (net_amount = amount - fee_amount)
);

CREATE TRIGGER trg_deposits_updated_at
BEFORE UPDATE ON deposits
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de levantamentos de fundos da carteira digital
CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reference_number VARCHAR(64) NOT NULL UNIQUE,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    amount BIGINT NOT NULL,     -- Valor líquido a ser enviado ao beneficiário
    fee_amount BIGINT NOT NULL DEFAULT 0,
    total_debited BIGINT NOT NULL, -- Total a debitar da carteira (amount + fee_amount)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    destination_type payout_destination_type NOT NULL,
    destination_account VARCHAR(100) NOT NULL, -- IBAN ou número de telemóvel associado
    destination_holder_name VARCHAR(150) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    provider_reference VARCHAR(150),
    status withdrawal_status NOT NULL DEFAULT 'REQUESTED',
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    settled_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,
    ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_withdrawal_positive CHECK (amount > 0 AND fee_amount >= 0),
    CONSTRAINT chk_withdrawal_total CHECK (total_debited = amount + fee_amount)
);

CREATE TRIGGER trg_withdrawals_updated_at
BEFORE UPDATE ON withdrawals
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 4. Tabela de transferências internas peer-to-peer entre membros
CREATE TABLE IF NOT EXISTS internal_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_number VARCHAR(64) NOT NULL UNIQUE,
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    sender_wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recipient_wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL,
    fee_amount BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status transfer_status NOT NULL DEFAULT 'PENDING',
    description VARCHAR(255),
    ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_transfer_positive CHECK (amount > 0 AND fee_amount >= 0),
    CONSTRAINT chk_different_wallets CHECK (sender_wallet_id <> recipient_wallet_id)
);

CREATE TRIGGER trg_internal_transfers_updated_at
BEFORE UPDATE ON internal_transfers
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();