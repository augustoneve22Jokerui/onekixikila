-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 017: ÍNDICES DE ALTA PERFORMANCE E INTEGRIDADE
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Índices para Utilizadores, Autenticação e Perfis
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_status_role ON users (status, role);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_location ON user_profiles (province, municipality);
CREATE INDEX IF NOT EXISTS idx_user_contacts_verification ON user_contacts (contact_value, is_verified);

-- ------------------------------------------------------------------------------
-- 2. Índices para Sessões, Dispositivos e Segurança
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions (user_id) WHERE is_revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_user_devices_lookup ON user_devices (user_id, device_fingerprint);

-- ------------------------------------------------------------------------------
-- 3. Índices para Grupos, Membros e Descoberta Geográfica
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_groups_status_frequency ON groups (status, frequency);
CREATE INDEX IF NOT EXISTS idx_groups_leader_creator ON groups (leader_id, creator_id);
CREATE INDEX IF NOT EXISTS idx_group_locations_geo ON group_locations (province, municipality, is_publicly_discoverable);
CREATE INDEX IF NOT EXISTS idx_group_memberships_composite ON group_memberships (group_id, status, role);
CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships (user_id, status);
CREATE INDEX IF NOT EXISTS idx_leadership_active ON leadership_assignments (group_id, status) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_group_invitations_lookup ON group_invitations (group_id, status, expires_at);

-- ------------------------------------------------------------------------------
-- 4. Índices para Calendários, Quotas e Rotações
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_schedules_due_date ON contribution_schedules (group_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_obligations_user_status ON contribution_obligations (user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_obligations_schedule ON contribution_obligations (schedule_id, status);
CREATE INDEX IF NOT EXISTS idx_contributions_user_schedule ON contributions (user_id, schedule_id, status);
CREATE INDEX IF NOT EXISTS idx_rotations_payout ON rotation_schedules (group_id, cycle_number, status, estimated_payout_date);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_turn ON beneficiary_assignments (rotation_id, beneficiary_user_id);

-- ------------------------------------------------------------------------------
-- 5. Índices para Carteiras, Livro-Razão e Partidas Dobradas
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets (user_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_lookup ON ledger_accounts (user_id, account_type);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_posted ON ledger_transactions (posted_at DESC, operation_type);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries (transaction_id, account_id, direction);

-- ------------------------------------------------------------------------------
-- 6. Índices para Depósitos, Levantamentos e Pagamentos Externos
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deposits_wallet_status ON deposits (wallet_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_wallet_status ON withdrawals (wallet_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_sender ON internal_transfers (sender_wallet_id, status);
CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON internal_transfers (recipient_wallet_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_lookup ON payment_requests (user_id, provider, status);
CREATE INDEX IF NOT EXISTS idx_provider_events_status ON payment_provider_events (provider, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_qr_tokens_active ON qr_tokens (status, expires_at) WHERE status = 'ACTIVE';

-- ------------------------------------------------------------------------------
-- 7. Índices para Chat, Notificações e Auditoria
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_chat_messages_group_timeline ON chat_messages (group_id, created_at DESC) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments (message_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, is_read, created_at DESC) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_audit_events_resource ON audit_events (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_lookup ON idempotency_keys (key, user_id, locked_until);

-- ------------------------------------------------------------------------------
-- 8. Função e Trigger para Verificação de Balanço nas Partidas Dobradas
-- ------------------------------------------------------------------------------
-- Garante que transações marcadas como 'POSTED' no livro-razão tenham somatório de débitos igual ao somatório de créditos
CREATE OR REPLACE FUNCTION verify_ledger_double_entry_balance()
RETURNS TRIGGER AS $$
DECLARE
    v_total_debit BIGINT;
    v_total_credit BIGINT;
BEGIN
    IF NEW.status = 'POSTED' THEN
        SELECT 
            COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)
        INTO v_total_debit, v_total_credit
        FROM ledger_entries
        WHERE transaction_id = NEW.id;

        -- Valida se há entradas e se a equação contábil fecha com precisão absoluta
        IF (v_total_debit = 0 AND v_total_credit = 0) OR (v_total_debit <> v_total_credit) THEN
            RAISE EXCEPTION 'Quebra de integridade contábil na transação %: Total Débito (%) difere do Total Crédito (%)',
                NEW.id, v_total_debit, v_total_credit;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_verify_ledger_balance ON ledger_transactions;
CREATE TRIGGER trg_verify_ledger_balance
AFTER UPDATE OF status ON ledger_transactions
FOR EACH ROW
WHEN (NEW.status = 'POSTED')
EXECUTE FUNCTION verify_ledger_double_entry_balance();