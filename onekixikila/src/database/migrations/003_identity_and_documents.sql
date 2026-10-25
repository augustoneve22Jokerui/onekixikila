-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 003: IDENTIDADE E DOCUMENTOS PRIVADOS
-- ==============================================================================

-- 1. Tipos enumerados para o ciclo de vida de validação KYC e tipos de documento
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'identity_verification_status') THEN
        CREATE TYPE identity_verification_status AS ENUM (
            'PENDING',
            'UNDER_REVIEW',
            'APPROVED',
            'REJECTED',
            'NEEDS_REVIEW',
            'EXPIRED'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_type') THEN
        CREATE TYPE document_type AS ENUM (
            'NATIONAL_ID',        -- Bilhete de Identidade Angolano
            'PASSPORT',           -- Passaporte
            'DRIVING_LICENSE',    -- Carta de Condução
            'FACIAL_PHOTO',       -- Fotografia facial / Liveness
            'PROOF_OF_ADDRESS'    -- Comprovativo de residência
        );
    END IF;
END $$;

-- 2. Tabela de processos de verificação de identidade (KYC)
CREATE TABLE IF NOT EXISTS identity_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id_number VARCHAR(50) NOT NULL,
    id_type document_type NOT NULL DEFAULT 'NATIONAL_ID',
    full_name_on_document VARCHAR(150),
    birth_date_on_document DATE,
    expiration_date DATE,
    status identity_verification_status NOT NULL DEFAULT 'PENDING',
    tier VARCHAR(32) NOT NULL DEFAULT 'TIER_1_UNVERIFIED',
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    review_notes TEXT,
    submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TRIGGER trg_identity_verifications_updated_at
BEFORE UPDATE ON identity_verifications
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Tabela de ficheiros e documentos associados às verificações
CREATE TABLE IF NOT EXISTS verification_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_id UUID NOT NULL REFERENCES identity_verifications(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type document_type NOT NULL,
    bucket_name VARCHAR(50) NOT NULL DEFAULT 'documentos',
    storage_key VARCHAR(255) NOT NULL UNIQUE,
    original_filename VARCHAR(255) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_hash_sha256 VARCHAR(64) NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CONSTRAINT chk_doc_size_limit CHECK (file_size_bytes <= 5242880) -- Limite estrito de 5 MB
);

CREATE TRIGGER trg_verification_documents_updated_at
BEFORE UPDATE ON verification_documents
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();