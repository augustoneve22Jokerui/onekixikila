const healthRepository = require('./health.repository');
const storageConfig = require('../../config/storage');
const appConfig = require('../../config/app');

/**
 * Serviço de regras de negócio para Verificação de Integridade (Health Check),
 * sondas de prontidão (Readiness) e vivacidade (Liveness) da plataforma OneKixikila.
 * Consolida o estado da base de dados Neon PostgreSQL, pool de conexões, consumo de memória
 * e adaptadores de armazenamento sem expor detalhes sensíveis de infraestrutura.
 */
class HealthService {
  /**
   * Sonda rápida de vivacidade (Liveness Probe).
   * Confirma que o processo Node.js e o event loop estão responsivos.
   *
   * @returns {{
   *   status: 'healthy',
   *   uptimeSeconds: number,
   *   timestamp: string
   * }}
   */
  getLiveness() {
    return {
      status: 'healthy',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Sonda de prontidão operacional (Readiness Probe).
   * Verifica ativamente a conectividade com o Neon PostgreSQL, versão do esquema de migrações
   * e métricas vitais de recursos para balanceadores de carga do Render.
   *
   * @returns {Promise<{
   *   status: 'healthy'|'unhealthy',
   *   service: string,
   *   environment: string,
   *   uptimeSeconds: number,
   *   timestamp: string,
   *   checks: {
   *     database: object,
   *     pool: object,
   *     migrations: object,
   *     memory: object
   *   }
   * }>}
   */
  async getReadiness() {
    const dbCheck = await healthRepository.checkDatabaseConnectivity();
    const poolMetrics = healthRepository.getPoolMetrics();
    const migrationsCheck = await healthRepository.checkMigrationsStatus();

    const memUsage = process.memoryUsage();
    const memoryMetrics = {
      rssMb: Math.round(memUsage.rss / (1024 * 1024)),
      heapUsedMb: Math.round(memUsage.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(memUsage.heapTotal / (1024 * 1024))
    };

    const isSystemHealthy = dbCheck.status === 'healthy';

    return {
      status: isSystemHealthy ? 'healthy' : 'unhealthy',
      service: appConfig.name,
      environment: appConfig.env,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: dbCheck.status,
          latencyMs: dbCheck.latencyMs,
          serverTime: dbCheck.serverTime
        },
        pool: poolMetrics,
        migrations: migrationsCheck,
        memory: memoryMetrics
      }
    };
  }

  /**
   * Consulta diagnóstica detalhada para painéis de observabilidade administrativa e monitorização interna.
   *
   * @returns {Promise<object>}
   */
  async getDetailedDiagnostics() {
    const readiness = await this.getReadiness();

    return {
      ...readiness,
      storage: {
        provider: storageConfig.provider,
        buckets: storageConfig.buckets
      },
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch
      }
    };
  }
}

// Instância singleton do serviço de health check
const healthService = new HealthService();

module.exports = healthService;