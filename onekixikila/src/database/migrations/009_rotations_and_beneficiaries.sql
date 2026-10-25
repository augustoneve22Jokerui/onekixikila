-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 009: ROTAÇÕES E ATRIBUIÇÃO DE BENEFICIÁRIOS
-- ==============================================================================

-- 1. Tipos enumerados para o ciclo de rotação do bolo financeiro da Kixikila
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rotation_status') THEN
        CREATE TYPE rotation_status AS ENUM (
            'PENDING',           -- Aguardando a conclusão da recolha das quotas da rodada
            'READY_FOR_PAYOUT',  -- Fundo total arrecadado e pronto para desembolso ao beneficiário
            'PAID_OUT',          -- Valor total entregue ao beneficiário da vez
            'SKIPPED',           -- Turno adiado por consenso ou inadimplência prévia
            'CANCELLED'          -- Turno cancelado por dissolução do ciclo
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'beneficiary_assignment_type') THEN
        CREATE TYPE beneficiary_assignment_type AS ENUM (
            'ORIGINAL_ORDER',      -- Ordem canónica estabelecida na formação do grupo
            'SWAP_REQUESTED',      -- Solicitação de troca de turno entre dois membros
            'SWAP_APPROVED',       -- Troca de turno validada pelo líder
            'EMERGENCY_OVERRIDE'   -- Atribuição emergencial por deliberação do grupo
        );
    END IF;
END $$;

-- 2. Tabela de turnos de rotação do ciclo
CREATE TABLE IF NOT EXISTS rotation_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    cycle_number INTEGER NOT NULL DEFAULT 1,
    position_order INTEGER NOT NULL, -- Posição ou turno da mão (1 a N)
    estimated_payout_date DATE NOT NULL,
    actual_payout_date DATE,
    pool_target_amount BIGINT NOT NULL, -- Montante total esperado em Kwanzas (AOA)
    actual_disbursed_amount BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status rotation_status NOT NULL DEFAULT 'PENDING',
    schedule_id UUID REFERENCES contribution_schedules(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_group_cycle_position UNIQUE (group_id, cycle_number, position_order),
    CONSTRAINT chk_pool_positive CHECK (pool_target_amount > 0 AND actual_disbursed_amount >= 0)
);

CREATE TRIGGER trg_rotation_schedules_updated_at
BEFORE UPDATE ON rotation_schedules
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de beneficiários atribuídos a cada turno da Kixikila
CREATE TABLE IF NOT EXISTS beneficiary_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rotation_id UUID NOT NULL REFERENCES rotation_schedules(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    beneficiary_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    membership_id UUID NOT NULL REFERENCES group_memberships(id) ON DELETE RESTRICT,
    assignment_type beneficiary_assignment_type NOT NULL DEFAULT 'ORIGINAL_ORDER',
    assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    swapped_with_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    swap_reason TEXT,
    approved_by_leader BOOLEAN NOT NULL DEFAULT TRUE,
    leader_approved_at TIMESTAMP WITH TIME ZONE,
    ledger_payout_id UUID, -- Relacionamento com a transação contábil de liquidação no livro-razão
    payout_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_beneficiary_assignments_updated_at
BEFORE UPDATE ON beneficiary_assignments
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();