-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 007: CONVITES E GEOLOCALIZAÇÃO PARA DESCOBERTA
-- ==============================================================================

-- 1. Tipos enumerados para ciclo de vida de convites e canais de partilha
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invitation_status') THEN
        CREATE TYPE invitation_status AS ENUM (
            'PENDING',   -- Convite ativo e aguardando uso
            'ACCEPTED',  -- Utilizado com sucesso pelo convidado
            'DECLINED',  -- Recusado pelo destinatário
            'EXPIRED',   -- Prazo limite de utilização ultrapassado
            'REVOKED'    -- Cancelado manualmente pelo líder emissor
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invitation_channel') THEN
        CREATE TYPE invitation_channel AS ENUM (
            'DIRECT_LINK', -- Ligação direta da plataforma
            'QR_CODE',     -- Código QR escaneável
            'SMS',         -- Mensagem SMS com link e token seguro
            'EMAIL',       -- E-mail institucional de convite
            'MANUAL_CODE'  -- Código alfanumérico digitado manualmente
        );
    END IF;
END $$;

-- 2. Tabela de convites seguros para adesão a grupos
CREATE TABLE IF NOT EXISTS group_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    invited_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    invite_code VARCHAR(64) NOT NULL UNIQUE,
    channel invitation_channel NOT NULL DEFAULT 'DIRECT_LINK',
    invited_phone VARCHAR(32),
    invited_email CITEXT,
    invited_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status invitation_status NOT NULL DEFAULT 'PENDING',
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_invitation_uses CHECK (used_count <= max_uses)
);

CREATE TRIGGER trg_group_invitations_updated_at
BEFORE UPDATE ON group_invitations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de localização geográfica aproximada para descoberta de grupos
CREATE TABLE IF NOT EXISTS group_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
    country VARCHAR(3) NOT NULL DEFAULT 'AGO',
    province VARCHAR(100) NOT NULL,
    municipality VARCHAR(100) NOT NULL,
    neighborhood VARCHAR(150),
    reference_point VARCHAR(255),
    approximate_latitude NUMERIC(10, 7),
    approximate_longitude NUMERIC(10, 7),
    radius_meters INTEGER NOT NULL DEFAULT 5000,
    is_publicly_discoverable BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_group_locations_updated_at
BEFORE UPDATE ON group_locations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();