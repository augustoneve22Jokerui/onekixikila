const { pool } = require('../database/pool');

/**
 * Gestor de bloqueios distribuídos baseado em Advisory Locks do PostgreSQL.
 * Assegura que em deploys com múltiplas instâncias no Render apenas uma réplica
 * execute tarefas agendadas em simultâneo, evitando concorrência destrutiva.
 */
class JobLock {
  constructor() {
    // Mantém os clientes de conexão dedicados aos bloqueios de sessão ativos
    this.activeLocks = new Map();
  }

  /**
   * Tenta adquirir um bloqueio consultivo não-bloqueante a nível de sessão no Neon PostgreSQL.
   *
   * @param {number} lockKey - Identificador numérico inteiro único para o bloqueio da tarefa
   * @returns {Promise<boolean>} True se o lock foi adquirido; False se outra réplica já o detém
   */
  async acquireLock(lockKey) {
    if (this.activeLocks.has(lockKey)) {
      return true;
    }

    let client;
    try {
      client = await pool.connect();
      const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired;', [lockKey]);

      const acquired = Boolean(result.rows[0] && result.rows[0].acquired);

      if (acquired) {
        this.activeLocks.set(lockKey, client);
        return true;
      }

      // Se não adquiriu o lock, liberta o cliente imediatamente para o pool
      client.release();
      return false;
    } catch (error) {
      if (client) {
        client.release();
      }
      console.error(`[JOB:LOCK:ERROR] Falha ao tentar adquirir lock [${lockKey}]:`, error.message);
      return false;
    }
  }

  /**
   * Liberta o bloqueio consultivo previamente adquirido e devolve o cliente ao pool.
   *
   * @param {number} lockKey
   * @returns {Promise<void>}
   */
  async releaseLock(lockKey) {
    const client = this.activeLocks.get(lockKey);

    if (!client) {
      return;
    }

    try {
      await client.query('SELECT pg_advisory_unlock($1);', [lockKey]);
    } catch (error) {
      console.error(`[JOB:LOCK:ERROR] Falha ao libertar lock [${lockKey}]:`, error.message);
    } finally {
      this.activeLocks.delete(lockKey);
      client.release();
    }
  }

  /**
   * Executa uma função protegida pelo bloqueio distribuído, libertando o recurso no encerramento.
   *
   * @template T
   * @param {number} lockKey
   * @param {() => Promise<T>} callback
   * @returns {Promise<T|null>}
   */
  async withLock(lockKey, callback) {
    const acquired = await this.acquireLock(lockKey);
    if (!acquired) {
      return null;
    }

    try {
      return await callback();
    } finally {
      await this.releaseLock(lockKey);
    }
  }
}

// Instância singleton do gestor de bloqueios
const jobLock = new JobLock();

module.exports = jobLock;