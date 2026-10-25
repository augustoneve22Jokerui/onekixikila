-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 014: DISPUTAS, EVENTOS DE RISCO E NOTIFICAÇÕES
-- ==============================================================================

-- 1. Tipos enumerados para resolução de disputas, matriz de risco e mensageria
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispute_status') THEN
        CREATE TYPE dispute_status AS ENUM (
            'OPEN',                         -- Contestação aberta pelo participante
            'UNDER_INVESTIGATION',          -- Em análise por liderança ou mediação da plataforma
            'RESOLVED_FAVOR_INITIATOR',     -- Procedente com compensação/ajuste
            'RESOLVED_FAVOR_RESPONDENT',    -- Improcedente mantendo os lançamentos originais
            'CLOSED_DISMISSED'              -- Encerrada sem mérito ou por desistência
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispute_category') THEN
        CREATE TYPE dispute_category AS ENUM (
            'CONTRIBUTION_UNACKNOWLEDGED', -- Quota debitada mas não reconhecida na rodada
            'ROTATION_ORDER_DISPUTE',       -- Alteração indevida da ordem da mão da Kixikila
            'UNAUTHORIZED_TRANSACTION',     -- Movimentação suspeita na carteira
            'WALLET_DISCREPANCY',           -- Divergência no saldo disponível vs contabilístico
            'LEADERSHIP_ABUSE',             -- Arbitrariedade de liderança do grupo
            'OTHER'                         -- Outros motivos de reclamação
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_level') THEN
        CREATE TYPE risk_level AS ENUM (
            'LOW',      -- Operação comum dentro dos padrões
            'MEDIUM',   -- Desvio de comportamento habitual
            'HIGH',     -- Tentativa de violação de limites ou logins anómalos
            'CRITICAL'  -- Ameaça iminente ou padrão de ataque de força bruta
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel') THEN
        CREATE TYPE notification_channel AS ENUM (
            'IN_APP',
            'EMAIL',
            'SMS',
            'PUSH'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
        CREATE TYPE notification_status AS ENUM (
            'PENDING',
            'SENT',
            'DELIVERED',
            'FAILED',
            'READ'
        );
    END IF;
END $$;

-- 2. Tabela de contestações formais e disputas entre participantes ou grupos
CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_code VARCHAR(50) NOT NULL UNIQUE,
    initiator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    respondent_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
    ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE SET NULL,
    category dispute_category NOT NULL,
    status dispute_status NOT NULL DEFAULT 'OPEN',
    amount_contested BIGINT, -- Montante financeiro disputado em Kwanzas (se houver)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    description TEXT NOT NULL,
    evidence_notes TEXT,
    resolution_notes TEXT,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_disputes_updated_at
BEFORE UPDATE ON disputes
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de deteção e auditoria preventiva de eventos de risco
CREATE TABLE IF NOT EXISTS risk_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    risk_level risk_level NOT NULL DEFAULT 'LOW',
    ip_address VARCHAR(45),
    user_agent TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    action_taken VARCHAR(100), -- 'NONE', 'TEMPORARY_HOLD', 'CHALLENGE_REQUIRED', 'ACCOUNT_FROZEN'
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

-- 4. Tabela de notificações multicanal da plataforma
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    channel notification_channel NOT NULL DEFAULT 'IN_APP',
    status notification_status NOT NULL DEFAULT 'PENDING',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMP WITH TIME ZONE,
    sent_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_notifications_updated_at
BEFORE UPDATE ON notifications
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();