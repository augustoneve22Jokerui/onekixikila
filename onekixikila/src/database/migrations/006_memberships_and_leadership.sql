-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 006: ADESÕES, PAPÉIS E DELEGAÇÃO DE LIDERANÇA
-- ==============================================================================

-- 1. Tipos enumerados para o ciclo de filiação e hierarquia de liderança
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'membership_status') THEN
        CREATE TYPE membership_status AS ENUM (
            'PENDING_APPROVAL', -- Aguardando análise do líder
            'ACTIVE',           -- Membro ativo e adimplente
            'PAUSED',           -- Participação temporariamente suspensa
            'SUSPENDED',        -- Suspenso por advertência ou atraso
            'DEFAULTED',        -- Em situação de incumprimento grave
            'LEFT',             -- Saiu voluntariamente após quitar compromissos
            'EXPELLED'          -- Expulso por violação de regras
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_member_role') THEN
        CREATE TYPE group_member_role AS ENUM (
            'MEMBER',           -- Membro participante regular
            'VICE_LEADER',      -- Vice-líder com poderes delegados
            'TREASURER',        -- Tesoureiro / Apoio à conciliação de quotas
            'SECRETARY'         -- Secretário / Apoio administrativo
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leadership_role') THEN
        CREATE TYPE leadership_role AS ENUM (
            'PRIMARY_LEADER',   -- Líder titular fundador
            'VICE_LEADER',      -- Vice-líder permanente
            'ACTING_LEADER'     -- Líder interino em caso de ausência
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leadership_status') THEN
        CREATE TYPE leadership_status AS ENUM (
            'ACTIVE',
            'DELEGATED',
            'REVOKED',
            'EXPIRED'
        );
    END IF;
END $$;

-- 2. Tabela de filiações e estados de participação em grupos de Kixikila
CREATE TABLE IF NOT EXISTS group_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role group_member_role NOT NULL DEFAULT 'MEMBER',
    status membership_status NOT NULL DEFAULT 'PENDING_APPROVAL',
    joined_at TIMESTAMP WITH TIME ZONE,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMP WITH TIME ZONE,
    suspension_reason TEXT,
    suspended_until TIMESTAMP WITH TIME ZONE,
    left_at TIMESTAMP WITH TIME ZONE,
    is_banned_from_chat BOOLEAN NOT NULL DEFAULT FALSE,
    is_contribution_restricted BOOLEAN NOT NULL DEFAULT FALSE,
    is_payout_restricted BOOLEAN NOT NULL DEFAULT FALSE,
    slot_number INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_group_membership UNIQUE (group_id, user_id)
);

CREATE TRIGGER trg_group_memberships_updated_at
BEFORE UPDATE ON group_memberships
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de registo histórico e atribuição de papéis de liderança
CREATE TABLE IF NOT EXISTS leadership_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    leadership_role leadership_role NOT NULL DEFAULT 'PRIMARY_LEADER',
    status leadership_status NOT NULL DEFAULT 'ACTIVE',
    assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revocation_reason TEXT,
    delegated_until TIMESTAMP WITH TIME ZONE,
    powers JSONB NOT NULL DEFAULT '{"can_approve_members": true, "can_manage_schedule": true, "can_moderate_chat": true}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_leadership_assignments_updated_at
BEFORE UPDATE ON leadership_assignments
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();