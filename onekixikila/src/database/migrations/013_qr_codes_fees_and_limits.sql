-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 013: CÓDIGOS QR, POLÍTICA DE TAXAS E LIMITES OPERACIONAIS
-- ==============================================================================

-- 1. Tipos enumerados para Códigos QR, cálculo de taxas e escopos de limites
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'qr_token_type') THEN
        CREATE TYPE qr_token_type AS ENUM (
            'GROUP_INVITE',    -- Convite dinâmico para adesão a grupo de Kixikila
            'PAYMENT_RECEIVE', -- Cobrança ou recebimento associado à carteira
            'DIRECT_TRANSFER', -- Transferência peer-to-peer presencial
            'DEVICE_LINK'      -- Vinculação autorizada de novo dispositivo
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'qr_token_status') THEN
        CREATE TYPE qr_token_status AS ENUM (
            'ACTIVE',  -- Válido e disponível para leitura
            'USED',    -- Consumido (aplicável a tokens de uso único)
            'EXPIRED', -- Prazo limite de validade ultrapassado
            'REVOKED'  -- Invalidado preventivamente pelo emissor
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fee_calculation_type') THEN
        CREATE TYPE fee_calculation_type AS ENUM (
            'FLAT',       -- Taxa fixa em Kwanzas
            'PERCENTAGE', -- Taxa proporcional em pontos-base
            'HYBRID'      -- Combinação de taxa fixa com percentagem
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'limit_scope') THEN
        CREATE TYPE limit_scope AS ENUM (
            'PER_TRANSACTION', -- Limite por operação individual
            'DAILY',           -- Limite cumulativo diário
            'MONTHLY'          -- Limite cumulativo mensal
        );
    END IF;
END $$;

-- 2. Tabela de emissão e controlo de códigos QR seguros (Anti-replay)
CREATE TABLE IF NOT EXISTS qr_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_code VARCHAR(128) NOT NULL UNIQUE,
    qr_type qr_token_type NOT NULL,
    status qr_token_status NOT NULL DEFAULT 'ACTIVE',
    creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    target_wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
    payment_request_id UUID REFERENCES payment_requests(id) ON DELETE SET NULL,
    fixed_amount BIGINT, -- Valor pré-definido em Kwanzas (se aplicável)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    max_scans INTEGER NOT NULL DEFAULT 1,
    scan_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_qr_scans CHECK (scan_count <= max_scans),
    CONSTRAINT chk_qr_amount CHECK (fixed_amount IS NULL OR fixed_amount > 0)
);

CREATE TRIGGER trg_qr_tokens_updated_at
BEFORE UPDATE ON qr_tokens
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de tabela de taxas e comissões da plataforma (Versionada e Auditável)
CREATE TABLE IF NOT EXISTS fees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fee_code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    operation_type financial_operation_type NOT NULL,
    calculation_type fee_calculation_type NOT NULL DEFAULT 'FLAT',
    flat_amount BIGINT NOT NULL DEFAULT 0, -- Em Kwanzas (AOA)
    basis_points INTEGER NOT NULL DEFAULT 0, -- 100 bps = 1.00%
    min_fee BIGINT NOT NULL DEFAULT 0,
    max_fee BIGINT,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    effective_to TIMESTAMP WITH TIME ZONE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_fees_updated_at
BEFORE UPDATE ON fees
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 4. Tabela de limites de conformidade e risco por nível de KYC
CREATE TABLE IF NOT EXISTS limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_code VARCHAR(50) NOT NULL, -- 'TIER_1_UNVERIFIED', 'TIER_2_VERIFIED', 'TIER_3_ENHANCED'
    operation_type financial_operation_type NOT NULL,
    scope limit_scope NOT NULL,
    max_amount BIGINT NOT NULL, -- Valor teto em Kwanzas
    max_count INTEGER,          -- Contagem máxima de eventos no intervalo
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_tier_operation_scope UNIQUE (tier_code, operation_type, scope),
    CONSTRAINT chk_limit_max_amount CHECK (max_amount > 0)
);

CREATE TRIGGER trg_limits_updated_at
BEFORE UPDATE ON limits
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();