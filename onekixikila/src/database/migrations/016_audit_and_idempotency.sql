-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 016: REGISTOS DE AUDITORIA E CHAVES DE IDEMPOTÊNCIA
-- ==============================================================================

-- 1. Tipos enumerados para ações de auditoria institucional e ciclo de idempotência
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_action') THEN
        CREATE TYPE audit_action AS ENUM (
            'CREATE',
            'UPDATE',
            'DELETE',
            'LOGIN',
            'LOGOUT',
            'PASSWORD_CHANGE',
            'ROLE_CHANGE',
            'STATUS_CHANGE',
            'KYC_REVIEW',
            'FINANCIAL_TRANSACTION',
            'EXPORT_DATA',
            'ADMIN_ACTION'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'idempotency_status') THEN
        CREATE TYPE idempotency_status AS ENUM (
            'PROCESSING', -- Pedido em execução atómica inicial
            'COMPLETED',  -- Resposta gravada com sucesso para repetição segura
            'FAILED'      -- Falha registada sem efeitos colaterais
        );
    END IF;
END $$;

-- 2. Tabela de eventos de auditoria institucional (Imutável / Append-only)
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(64), -- Identificador de rastreamento de ponta a ponta (X-Request-ID)
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50),
    ip_address VARCHAR(45),
    user_agent TEXT,
    action audit_action NOT NULL,
    resource_type VARCHAR(100) NOT NULL, -- 'USER', 'WALLET', 'GROUP', 'IDENTITY', 'CONTRIBUTION'
    resource_id VARCHAR(100),
    old_values JSONB, -- Estado prévio com dados sensíveis previamente higienizados
    new_values JSONB, -- Novo estado persistido
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

-- 3. Tabela de chaves de idempotência para operações financeiras e mutações críticas
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(120) NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    route_path VARCHAR(255) NOT NULL,
    http_method VARCHAR(10) NOT NULL,
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 do payload para garantir identidade do pedido
    status idempotency_status NOT NULL DEFAULT 'PROCESSING',
    response_code INTEGER,
    response_headers JSONB,
    response_body JSONB,
    locked_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_idempotency_keys_updated_at
BEFORE UPDATE ON idempotency_keys
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();