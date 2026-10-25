const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, closePool } = require('./pool');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

// Chave fixa para bloqueio consultivo no PostgreSQL (advisory lock) impedindo concorrência
const MIGRATION_LOCK_KEY = 739281729;

/**
 * Calcula o checksum SHA-256 do ficheiro de migração para integridade.
 * @param {string} content
 * @returns {string}
 */
const calculateChecksum = (content) => {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
};

/**
 * Garante a existência da tabela de controlo de versões de migrações.
 * @param {import('pg').PoolClient} client
 */
const ensureMigrationsTable = async (client) => {
  const query = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR(255) NOT NULL UNIQUE,
      checksum VARCHAR(64) NOT NULL,
      execution_time_ms INTEGER NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'UTC')
    );
  `;
  await client.query(query);
};

/**
 * Executa todas as migrações SQL pendentes na ordem numérica estrita.
 * Utiliza pg_advisory_lock para evitar execuções concorrentes simultâneas em ambientes como o Render.
 */
const runMigrations = async () => {
  const client = await pool.connect();

  console.log('\n[DATABASE:MIGRATIONS] Iniciando verificação de esquema no Neon PostgreSQL...');

  try {
    // Adquire bloqueio consultivo exclusivo na sessão
    await client.query('SELECT pg_advisory_lock($1);', [MIGRATION_LOCK_KEY]);

    await ensureMigrationsTable(client);

    // Consulta migrações já aplicadas
    const { rows: appliedRows } = await client.query('SELECT migration_name FROM schema_migrations;');
    const appliedSet = new Set(appliedRows.map((r) => r.migration_name));

    // Carrega e ordena ficheiros .sql do diretório de migrações
    if (!fs.existsSync(MIGRATIONS_DIR)) {
      throw new Error(`Diretório de migrações não encontrado: ${MIGRATIONS_DIR}`);
    }

    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    let appliedCount = 0;

    for (const file of migrationFiles) {
      if (appliedSet.has(file)) {
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sqlContent = fs.readFileSync(filePath, 'utf8');
      const checksum = calculateChecksum(sqlContent);

      console.log(`[DATABASE:MIGRATIONS] Executando: ${file}...`);
      const startTime = Date.now();

      await client.query('BEGIN;');
      try {
        await client.query(sqlContent);

        const executionTimeMs = Date.now() - startTime;
        await client.query(
          `INSERT INTO schema_migrations (migration_name, checksum, execution_time_ms)
           VALUES ($1, $2, $3);`,
          [file, checksum, executionTimeMs]
        );

        await client.query('COMMIT;');
        appliedCount += 1;
        console.log(`[DATABASE:MIGRATIONS] ✓ Concluído: ${file} (${executionTimeMs}ms)`);
      } catch (migrationError) {
        await client.query('ROLLBACK;');
        console.error(`[DATABASE:MIGRATIONS] ✕ Erro fatal ao executar ${file}:`, migrationError.message);
        throw migrationError;
      }
    }

    if (appliedCount === 0) {
      console.log('[DATABASE:MIGRATIONS] Esquema da base de dados já está atualizado. Nenhuma nova migração necessária.\n');
    } else {
      console.log(`[DATABASE:MIGRATIONS] Sucesso: ${appliedCount} migração(ões) aplicada(s) com sucesso.\n`);
    }

    return { appliedCount };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1);', [MIGRATION_LOCK_KEY]);
    } catch (unlockError) {
      console.error('[DATABASE:MIGRATIONS] Erro ao libertar pg_advisory_lock:', unlockError.message);
    }
    client.release();
  }
};

// Execução direta via CLI (npm run db:migrate)
if (require.main === module) {
  runMigrations()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[DATABASE:MIGRATIONS:FATAL]', err.message);
      await closePool();
      process.exit(1);
    });
}

module.exports = {
  runMigrations,
  ensureMigrationsTable
};