-- ==============================================================================
-- ONEKIXIKILA — MIGRAÇÃO 001: EXTENSÕES E FUNÇÕES BASE
-- ==============================================================================

-- 1. Extensão para geração de identificadores UUID v4 e funções criptográficas
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Extensão para campos de texto insensíveis a maiúsculas/minúsculas (emails, usernames)
CREATE EXTENSION IF NOT EXISTS "citext";

-- 3. Extensão btree_gist para suporte a restrições de exclusão temporal e integridade
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 4. Função universal para atualização automática da coluna updated_at em tabelas mutáveis
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;