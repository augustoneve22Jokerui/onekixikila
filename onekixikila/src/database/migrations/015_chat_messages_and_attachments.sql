-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 015: MENSAGENS, ÁUDIO E ANEXOS DO CHAT DE GRUPO
-- ==============================================================================

-- 1. Tipos enumerados para categorias de mensagens, anexos e moderação de chat
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_message_type') THEN
        CREATE TYPE chat_message_type AS ENUM (
            'TEXT',         -- Mensagem textual simples
            'AUDIO',        -- Nota de voz gravada
            'DOCUMENT',     -- Documento PDF ou ficheiro com anexo
            'SYSTEM_EVENT'  -- Mensagem automática informativa gerada pelo sistema
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attachment_type') THEN
        CREATE TYPE attachment_type AS ENUM (
            'AUDIO',    -- Ficheiro de voz
            'DOCUMENT', -- Documento (PDF, etc.)
            'IMAGE'     -- Fotografia ou imagem ilustrativa
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_report_status') THEN
        CREATE TYPE chat_report_status AS ENUM (
            'PENDING',            -- Denúncia pendente de análise
            'REVIEWED_FLAGGED',   -- Mensagem censurada ou autor advertido
            'REVIEWED_DISMISSED', -- Denúncia considerada infundada
            'ACTION_TAKEN'        -- Mensagem removida ou membro expulso do chat
        );
    END IF;
END $$;

-- 2. Tabela de mensagens do chat privado de grupo
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Nulo para eventos do sistema
    message_type chat_message_type NOT NULL DEFAULT 'TEXT',
    content TEXT,
    client_message_id VARCHAR(64), -- Identificador único gerado no cliente para deduplicação
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_chat_messages_updated_at
BEFORE UPDATE ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de anexos multimédia e ficheiros com verificação estrita de limites
CREATE TABLE IF NOT EXISTS chat_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    attachment_type attachment_type NOT NULL,
    bucket_name VARCHAR(50) NOT NULL DEFAULT 'documentos',
    storage_key VARCHAR(255) NOT NULL UNIQUE,
    original_filename VARCHAR(255) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_hash_sha256 VARCHAR(64) NOT NULL,
    duration_seconds INTEGER, -- Duração em segundos para ficheiros de áudio
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    -- Restrições físicas inegociáveis de conformidade e armazenamento
    CONSTRAINT chk_document_limit CHECK (
        attachment_type <> 'DOCUMENT' OR file_size_bytes <= 5242880 -- Limite estrito de 5 MB
    ),
    CONSTRAINT chk_audio_limit CHECK (
        attachment_type <> 'AUDIO' OR (file_size_bytes <= 10485760 AND (duration_seconds IS NULL OR duration_seconds <= 120)) -- 10 MB / 120s
    )
);

-- 4. Tabela de recibos de entrega e leitura das mensagens
CREATE TABLE IF NOT EXISTS chat_message_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT uq_msg_user_receipt UNIQUE (message_id, user_id)
);

-- 5. Tabela de denúncias e moderação de conduta comunitária
CREATE TABLE IF NOT EXISTS chat_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    reported_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason VARCHAR(255) NOT NULL,
    status chat_report_status NOT NULL DEFAULT 'PENDING',
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    resolution_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_chat_reports_updated_at
BEFORE UPDATE ON chat_reports
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();