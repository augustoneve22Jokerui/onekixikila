const { pool } = require('../../database/pool');
const { queryOne } = require('../../database/query');

/**
 * Repositório de diagnósticos de persistência e integridade de ligação para a base de dados Neon PostgreSQL.
 * Mede a latência de consultas pontuais, estado do pool de conexões e versão do esquema de migrações,
 * sem expor credenciais, endereços de host ou dados sensíveis de infraestrutura.
 */
class HealthRepository {
  /**
   * Executa uma consulta de verificação de pulso (Heartbeat) na base de dados Neon PostgreSQL
   * e mede a latência em milissegundos.
   *
   * @returns {Promise<{
   *   status: 'healthy'|'unhealthy',
   *   latencyMs: number,
   *   serverTime: string|null,
   *   error?: string
   * }>}
   */
  async checkDatabaseConnectivity() {
    const startTime = Date.now();
    try {
      const result = await queryOne('SELECT 1 AS alive, NOW() AS server_time;');
      const latencyMs = Date.now() - startTime;

      return {
        status: 'healthy',
        latencyMs,
        serverTime: result && result.server_time ? result.server_time.toISOString() : null
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        status: 'unhealthy',
        latencyMs,
        serverTime: null,
        error: error.message
      };
    }
  }

  /**
   * Obtém as métricas de conexões do pool PostgreSQL gerido pelo driver pg.
   *
   * @returns {{
   *   totalConnections: number,
   *   idleConnections: number,
   *   waitingRequests: number
   * }}
   */
  getPoolMetrics() {
    return {
      totalConnections: pool.totalCount || 0,
      idleConnections: pool.idleCount || 0,
      waitingRequests: pool.waitingCount || 0
    };
  }

  /**
   * Verifica o estado da tabela de migrações (`schema_migrations`) para diagnosticar
   * a conformidade do esquema da base de dados.
   *
   * @returns {Promise<{
   *   migrationsTableExists: boolean,
   *   totalAppliedMigrations: number,
   *   latestMigration: string|null
   * }>}
   */
  async checkMigrationsStatus() {
    try {
      const text = `
        SELECT 
          COUNT(*)::integer AS total_applied,
          (
            SELECT migration_name 
            FROM schema_migrations 
            ORDER BY id DESC 
            LIMIT 1
          ) AS latest_migration
        FROM schema_migrations;
      `;
      const result = await queryOne(text);

      return {
        migrationsTableExists: true,
        totalAppliedMigrations: result ? Number(result.total_applied) : 0,
        latestMigration: result ? result.latest_migration : null
      };
    } catch (error) {
      return {
        migrationsTableExists: false,
        totalAppliedMigrations: 0,
        latestMigration: null
      };
    }
  }
}

// Instância singleton do repositório de health check
const healthRepository = new HealthRepository();

module.exports = healthRepository;