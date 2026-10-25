-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 004: DISPOSITIVOS E SESSÕES REVOGÁVEIS
-- ==============================================================================

-- 1. Tabela de dispositivos reconhecidos dos utilizadores
CREATE TABLE IF NOT EXISTS user_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_fingerprint VARCHAR(255) NOT NULL,
    device_name VARCHAR(150),
    device_type VARCHAR(50) NOT NULL DEFAULT 'OTHER', -- 'MOBILE', 'DESKTOP', 'TABLET', 'OTHER'
    operating_system VARCHAR(100),
    browser VARCHAR(100),
    push_token VARCHAR(255),
    is_trusted BOOLEAN NOT NULL DEFAULT FALSE,
    last_ip_address VARCHAR(45),
    last_active_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_user_device_fingerprint UNIQUE (user_id, device_fingerprint)
);

CREATE TRIGGER trg_user_devices_updated_at
BEFORE UPDATE ON user_devices
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 2. Tabela de sessões de utilizador com capacidade de revogação explícita
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES user_devices(id) ON DELETE SET NULL,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_reason VARCHAR(255), -- 'USER_LOGOUT', 'SECURITY_ROTATION', 'ADMIN_REVOKE', 'PASSWORD_CHANGED'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_sessions_updated_at
BEFORE UPDATE ON sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();