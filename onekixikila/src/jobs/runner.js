const jobLock = require('./job-lock');
const contributionsDueJob = require('./contributions-due.job');
const notificationsJob = require('./notifications.job');
const qrExpirationJob = require('./qr-expiration.job');
const paymentReconciliationJob = require('./payment-reconciliation.job');
const sessionCleanupJob = require('./session-cleanup.job');
const storageRetentionJob = require('./storage-retention.job');
const { closePool } = require('../database/pool');

/**
 * Catálogo e intervalo de execução das tarefas agendadas em segundo plano (em milissegundos).
 */
const REGISTERED_JOBS = [
  {
    name: 'notifications-dispatch',
    lockKey: 1001,
    intervalMs: 30 * 1000, // 30 segundos
    handler: notificationsJob
  },
  {
    name: 'qr-expiration',
    lockKey: 1002,
    intervalMs: 5 * 60 * 1000, // 5 minutos
    handler: qrExpirationJob
  },
  {
    name: 'contributions-due',
    lockKey: 1003,
    intervalMs: 15 * 60 * 1000, // 15 minutos
    handler: contributionsDueJob
  },
  {
    name: 'payment-reconciliation',
    lockKey: 1004,
    intervalMs: 30 * 60 * 1000, // 30 minutos
    handler: paymentReconciliationJob
  },
  {
    name: 'session-cleanup',
    lockKey: 1005,
    intervalMs: 6 * 60 * 60 * 1000, // 6 horas
    handler: sessionCleanupJob
  },
  {
    name: 'storage-retention',
    lockKey: 1006,
    intervalMs: 24 * 60 * 60 * 1000, // 24 horas
    handler: storageRetentionJob
  }
];

class JobRunner {
  constructor() {
    this.timers = [];
    this.isRunning = false;
  }

  /**
   * Executa uma tarefa individual encapsulada por bloqueio distribuído (Advisory Lock do PostgreSQL)
   * para assegurar que múltiplas instâncias no Render não executem o mesmo processo em simultâneo.
   *
   * @param {object} jobDef
   */
  async executeJob(jobDef) {
    const { name, lockKey, handler } = jobDef;

    // Tenta adquirir o bloqueio consultivo não bloqueante no Neon PostgreSQL
    const acquired = await jobLock.acquireLock(lockKey);
    if (!acquired) {
      // Outra réplica do web service já está a executar esta tarefa
      return;
    }

    const startTime = Date.now();
    try {
      console.log(`[JOB:RUNNER:START] Iniciando tarefa agendada: [${name}]...`);
      const result = await handler.run();
      const durationMs = Date.now() - startTime;
      console.log(`[JOB:RUNNER:FINISH] Tarefa [${name}] concluída em ${durationMs}ms. Resultado:`, result || 'OK');
    } catch (jobError) {
      const durationMs = Date.now() - startTime;
      console.error(`[JOB:RUNNER:ERROR] Falha na execução da tarefa [${name}] após ${durationMs}ms:`, jobError.message);
    } finally {
      await jobLock.releaseLock(lockKey);
    }
  }

  /**
   * Inicia o agendamento de todas as rotinas em segundo plano.
   */
  startAllJobs() {
    if (this.isRunning) {
      return;
    }

    console.log('\n[JOB:RUNNER] Inicializando motor de tarefas agendadas em segundo plano...');
    this.isRunning = true;

    for (const jobDef of REGISTERED_JOBS) {
      // Disparo inicial desfasado para evitar concorrência simultânea na inicialização
      setTimeout(() => {
        if (this.isRunning) {
          this.executeJob(jobDef);
        }
      }, 5000 + Math.random() * 5000);

      // Agendamento cíclico
      const timer = setInterval(() => {
        if (this.isRunning) {
          this.executeJob(jobDef);
        }
      }, jobDef.intervalMs);

      this.timers.push(timer);
    }

    console.log(`[JOB:RUNNER] ${REGISTERED_JOBS.length} tarefas agendadas ativas com bloqueio distribuído.`);
  }

  /**
   * Interrompe todos os temporizadores para um encerramento gracioso (Graceful Shutdown).
   */
  stopAllJobs() {
    if (!this.isRunning) {
      return;
    }

    console.log('[JOB:RUNNER] Parando agendamentos de segundo plano...');
    this.isRunning = false;

    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    console.log('[JOB:RUNNER] Todos os timers foram cancelados.');
  }

  /**
   * Permite o disparo imediato de uma tarefa sob demanda (via CLI ou painel de administração).
   *
   * @param {string} jobName
   */
  async runJobNow(jobName) {
    const jobDef = REGISTERED_JOBS.find((j) => j.name === jobName);
    if (!jobDef) {
      throw new Error(`[JOB:RUNNER] Tarefa [${jobName}] não encontrada no catálogo de tarefas registradas.`);
    }
    return this.executeJob(jobDef);
  }
}

// Instância singleton do orquestrador
const runner = new JobRunner();

// Suporte para execução direta via terminal (ex: node src/jobs/runner.js)
if (require.main === module) {
  runner.startAllJobs();

  const shutdown = async () => {
    runner.stopAllJobs();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = runner;