-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 002: UTILIZADORES, PERFIS E CONTACTOS
-- ==============================================================================

-- 1. Tipos enumerados para estados e permissões de utilizadores
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
        CREATE TYPE user_status AS ENUM (
            'PENDING_VERIFICATION',
            'ACTIVE',
            'SUSPENDED',
            'BLOCKED',
            'DEACTIVATED'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM (
            'USER',
            'MEMBER',
            'GROUP_LEADER',
            'MODERATOR',
            'SUPPORT_AGENT',
            'AUDITOR',
            'ADMIN',
            'FINANCIAL_OPERATOR'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contact_type') THEN
        CREATE TYPE contact_type AS ENUM (
            'PHONE_PRIMARY',
            'PHONE_SECONDARY',
            'EMAIL_PRIMARY',
            'EMAIL_BACKUP'
        );
    END IF;
END $$;

-- 2. Tabela principal de utilizadores e credenciais de acesso
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    phone_number VARCHAR(32) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'USER',
    status user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
    is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    is_phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    email_verified_at TIMESTAMP WITH TIME ZONE,
    phone_verified_at TIMESTAMP WITH TIME ZONE,
    terms_accepted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    terms_version VARCHAR(32) NOT NULL DEFAULT '1.0',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de perfis detalhados e preferências dos utilizadores
CREATE TABLE IF NOT EXISTS user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    preferred_name VARCHAR(100),
    avatar_url VARCHAR(500),
    date_of_birth DATE,
    gender VARCHAR(20),
    country VARCHAR(3) NOT NULL DEFAULT 'AGO',
    province VARCHAR(100),
    municipality VARCHAR(100),
    neighborhood VARCHAR(150),
    address_line TEXT,
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    location_authorized BOOLEAN NOT NULL DEFAULT FALSE,
    preferred_locale VARCHAR(10) NOT NULL DEFAULT 'pt-AO',
    preferred_currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    notification_preferences JSONB NOT NULL DEFAULT '{"email": true, "sms": true, "in_app": true}'::jsonb,
    bio VARCHAR(300),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_user_profiles_updated_at
BEFORE UPDATE ON user_profiles
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 4. Tabela de contactos adicionais e registo de validação OTP
CREATE TABLE IF NOT EXISTS user_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_type contact_type NOT NULL,
    contact_value VARCHAR(150) NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMP WITH TIME ZONE,
    verification_code_hash VARCHAR(255),
    verification_code_expires_at TIMESTAMP WITH TIME ZONE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_user_contact_value UNIQUE (user_id, contact_type, contact_value)
);

CREATE TRIGGER trg_user_contacts_updated_at
BEFORE UPDATE ON user_contacts
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();