-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 012: PEDIDOS DE PAGAMENTO, EVENTOS DE PRESTADORES E RECONCILIAÇÃO
-- ==============================================================================

-- 1. Tipos enumerados para pedidos externos, eventos de webhooks e reconciliação
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_request_status') THEN
        CREATE TYPE payment_request_status AS ENUM (
            'PENDING',    -- Pedido enviado ao gateway e aguardando ação do pagador
            'PROCESSING', -- Pagamento em autorização na rede interbancária
            'SUCCEEDED',  -- Transação autorizada e fundos capturados
            'FAILED',     -- Pagamento rejeitado pelo gateway ou emissor
            'EXPIRED',    -- Tempo limite de pagamento expirado
            'CANCELLED',  -- Cancelado pelo cliente ou pelo sistema
            'REFUNDED'    -- Estornado ao método de pagamento de origem
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provider_event_status') THEN
        CREATE TYPE provider_event_status AS ENUM (
            'RECEIVED',   -- Webhook recebido e gravado na íntegra
            'VERIFIED',   -- Assinatura HMAC validada com sucesso
            'PROCESSED',  -- Evento processado com liquidação confirmada
            'FAILED',     -- Falha durante a execução da lógica de liquidação
            'DUPLICATE',  -- Notificação idêntica já processada (descarte seguro)
            'IGNORED'     -- Evento com tipo não relevante para contabilidade
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reconciliation_status') THEN
        CREATE TYPE reconciliation_status AS ENUM (
            'PENDING',              -- Lote de conciliação em processamento
            'MATCHED',              -- Valores internos e externos coincidem perfeitamente
            'DISCREPANCY_AMOUNT',   -- Divergência no total liquidado
            'DISCREPANCY_STATUS',   -- Estado interno difere do relatório bancário
            'MANUALLY_RESOLVED'     -- Divergência apurada e ajustada por auditor
        );
    END IF;
END $$;

-- 2. Tabela de pedidos de pagamento gerados para os gateways angolanos
CREATE TABLE IF NOT EXISTS payment_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    deposit_id UUID REFERENCES deposits(id) ON DELETE SET NULL,
    contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
    merchant_reference VARCHAR(64) NOT NULL UNIQUE,
    provider_transaction_id VARCHAR(150),
    provider VARCHAR(50) NOT NULL, -- 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'
    channel VARCHAR(50) NOT NULL DEFAULT 'MOBILE', -- 'MOBILE', 'QR_CODE', 'USSD', 'WEB'
    amount BIGINT NOT NULL,        -- Montante em Kwanzas inteiros (AOA)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    phone_number VARCHAR(32),
    status payment_request_status NOT NULL DEFAULT 'PENDING',
    qr_payload TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_payment_amount_positive CHECK (amount > 0)
);

CREATE TRIGGER trg_payment_requests_updated_at
BEFORE UPDATE ON payment_requests
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de eventos e webhooks recebidos dos prestadores de pagamento (Auditável e Idempotente)
CREATE TABLE IF NOT EXISTS payment_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(50) NOT NULL,
    event_id VARCHAR(150) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    signature_header TEXT,
    is_signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
    status provider_event_status NOT NULL DEFAULT 'RECEIVED',
    payload JSONB NOT NULL,
    processing_error TEXT,
    payment_request_id UUID REFERENCES payment_requests(id) ON DELETE SET NULL,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    processed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_provider_event UNIQUE (provider, event_id)
);

-- 4. Tabela de lotes de reconciliação contábil com extratos dos prestadores
CREATE TABLE IF NOT EXISTS payment_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_reference VARCHAR(64) NOT NULL UNIQUE,
    provider VARCHAR(50) NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    total_expected_records INTEGER NOT NULL DEFAULT 0,
    total_matched_records INTEGER NOT NULL DEFAULT 0,
    total_discrepancy_records INTEGER NOT NULL DEFAULT 0,
    total_amount_internal BIGINT NOT NULL DEFAULT 0,
    total_amount_external BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status reconciliation_status NOT NULL DEFAULT 'PENDING',
    reconciled_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reconciled_at TIMESTAMP WITH TIME ZONE,
    report_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_payment_reconciliations_updated_at
BEFORE UPDATE ON payment_reconciliations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();