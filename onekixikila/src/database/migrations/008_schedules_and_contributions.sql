-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 008: CALENDÁRIO, OBRIGAÇÕES E CONTRIBUIÇÕES
-- ==============================================================================

-- 1. Tipos enumerados para cronogramas e cumprimento de obrigações de quota
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_status') THEN
        CREATE TYPE schedule_status AS ENUM (
            'SCHEDULED', -- Agendado no cronograma
            'ACTIVE',    -- Rodada em curso para recolha de quotas
            'COMPLETED', -- Todas as quotas da rodada arrecadadas e transferidas
            'CANCELLED'  -- Rodada cancelada
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'obligation_status') THEN
        CREATE TYPE obligation_status AS ENUM (
            'PENDING',   -- Quota pendente de pagamento
            'PAID',      -- Liquidada integralmente
            'LATE',      -- Vencida e dentro do período de carência/multa
            'DEFAULTED', -- Incumprimento transitado após prazo de carência
            'EXCUSED'    -- Dispensada formalmente pelo regulamento
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contribution_status') THEN
        CREATE TYPE contribution_status AS ENUM (
            'INITIATED',  -- Tentativa de liquidação iniciada
            'PROCESSING', -- Em liquidação contábil ou bancária
            'CONFIRMED',  -- Confirmada com fundos verificados e lançados no razão
            'FAILED',     -- Falha na liquidação
            'REFUNDED'    -- Estornada formalmente
        );
    END IF;
END $$;

-- 2. Tabela de rodadas do cronograma do grupo de Kixikila
CREATE TABLE IF NOT EXISTS contribution_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    cycle_number INTEGER NOT NULL DEFAULT 1,
    round_number INTEGER NOT NULL DEFAULT 1,
    due_date DATE NOT NULL,
    grace_period_end_date DATE NOT NULL,
    expected_amount_per_member BIGINT NOT NULL, -- Valor em Kwanzas inteiros (AOA)
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status schedule_status NOT NULL DEFAULT 'SCHEDULED',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_group_cycle_round UNIQUE (group_id, cycle_number, round_number)
);

CREATE TRIGGER trg_contribution_schedules_updated_at
BEFORE UPDATE ON contribution_schedules
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de obrigações financeiras individuais exigíveis por membro em cada rodada
CREATE TABLE IF NOT EXISTS contribution_obligations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL REFERENCES contribution_schedules(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    membership_id UUID NOT NULL REFERENCES group_memberships(id) ON DELETE RESTRICT,
    expected_amount BIGINT NOT NULL,
    paid_amount BIGINT NOT NULL DEFAULT 0,
    late_fee_assessed BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status obligation_status NOT NULL DEFAULT 'PENDING',
    due_date DATE NOT NULL,
    grace_date DATE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_schedule_user_obligation UNIQUE (schedule_id, user_id)
);

CREATE TRIGGER trg_contribution_obligations_updated_at
BEFORE UPDATE ON contribution_obligations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 4. Tabela de pagamentos/contribuições de quota efetivamente executados
CREATE TABLE IF NOT EXISTS contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obligation_id UUID NOT NULL REFERENCES contribution_obligations(id) ON DELETE RESTRICT,
    schedule_id UUID NOT NULL REFERENCES contribution_schedules(id) ON DELETE RESTRICT,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL,
    fee_amount BIGINT NOT NULL DEFAULT 0,
    total_debited BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'AOA',
    status contribution_status NOT NULL DEFAULT 'INITIATED',
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    payment_method VARCHAR(50) NOT NULL DEFAULT 'INTERNAL_WALLET',
    ledger_transaction_id UUID, -- Chave de relacionamento contábil com a tabela ledger_transactions
    confirmed_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_contribution_values CHECK (amount > 0 AND total_debited >= amount)
);

CREATE TRIGGER trg_contributions_updated_at
BEFORE UPDATE ON contributions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();