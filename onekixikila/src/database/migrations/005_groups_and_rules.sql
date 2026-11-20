-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 005: GRUPOS DE KIXIKILA E REGRAS OPERACIONAIS
-- ==============================================================================

-- 1. Tipos enumerados para o ciclo de vida e frequência da Kixikila
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_status') THEN
        CREATE TYPE group_status AS ENUM (
            'DRAFT',        -- Em configuração inicial
            'FORMATION',    -- Aberto para angariação e validação de membros
            'ACTIVE',       -- Em funcionamento regular e rotação financeira
            'PAUSED',       -- Pausado temporariamente para resolução de disputas
            'COMPLETED',    -- Todos os ciclos de rotação concluídos com sucesso
            'SUSPENDED',    -- Interrupção de conformidade ou risco administrativo
            'CANCELLED'     -- Cancelado antes do início formal
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_frequency') THEN
        CREATE TYPE group_frequency AS ENUM (
            'DAILY',        -- Diário
            'WEEKLY',       -- Semanal
            'BIWEEKLY',     -- Quinzenal
            'MONTHLY'       -- Mensal (padrão habitual em Angola)
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rotation_order_type') THEN
        CREATE TYPE rotation_order_type AS ENUM (
            'FIXED',        -- Ordem estática predeterminada no regulamento
            'AUCTION',      -- Leilão de turno da Kixikila
            'RANDOM_DRAW',  -- Sorteio transparente
            'CONSENSUS'     -- Acordo entre todos os participantes
        );
    END IF;
END $$;

-- 2. Tabela de grupos de Kixikila
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    leader_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(180) NOT NULL UNIQUE,
    description TEXT,
    status group_status NOT NULL DEFAULT 'FORMATION',
    frequency group_frequency NOT NULL DEFAULT 'MONTHLY',
    contribution_amount BIGINT NOT NULL, -- Valor de quota em Kwanzas inteiros (AOA)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    min_members INTEGER NOT NULL DEFAULT 3,
    max_members INTEGER NOT NULL DEFAULT 50,
    current_cycle INTEGER NOT NULL DEFAULT 1,
    total_cycles INTEGER NOT NULL DEFAULT 1,
    start_date DATE,
    end_date DATE,
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    allow_auto_debit BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_contribution_positive CHECK (contribution_amount >= 1000),
    CONSTRAINT chk_members_bounds CHECK (min_members >= 3 AND max_members <= 100 AND min_members <= max_members)
);

CREATE TRIGGER trg_groups_updated_at
BEFORE UPDATE ON groups
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de regras e regulamento imutável de cada grupo
CREATE TABLE IF NOT EXISTS group_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
    rotation_type rotation_order_type NOT NULL DEFAULT 'FIXED',
    grace_period_days INTEGER NOT NULL DEFAULT 2,
    late_fee_type VARCHAR(20) NOT NULL DEFAULT 'FIXED', -- 'FIXED', 'PERCENTAGE', 'NONE'
    late_fee_value BIGINT NOT NULL DEFAULT 0,          -- Valor fixo em Kz ou pontos-base de percentagem
    allow_early_payout BOOLEAN NOT NULL DEFAULT FALSE,
    require_admin_approval_to_join BOOLEAN NOT NULL DEFAULT TRUE,
    require_identity_verification BOOLEAN NOT NULL DEFAULT TRUE, -- Exigência de KYC Aprovado
    default_payout_rule TEXT,
    dispute_resolution_rule TEXT,
    terms_and_conditions TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_grace_period_positive CHECK (grace_period_days >= 0)
);

CREATE TRIGGER trg_group_rules_updated_at
BEFORE UPDATE ON group_rules
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();