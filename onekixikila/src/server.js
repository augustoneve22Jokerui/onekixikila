const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const env = require('./config/env');
const appConfig = require('./config/app');
const corsConfig = require('./config/cors');
const { testConnection, closePool } = require('./database/pool');
const { runMigrations } = require('./database/migration-runner');
const runner = require('./jobs/runner');
const chatGateway = require('./modules/chat/chat.gateway');
const logger = require('./shared/logging/logger');

const serverLogger = logger.child({ module: 'SERVER' });

// -----------------------------------------------------------------------------
// 1. CRIAÇÃO DO SERVIDOR HTTP NATIVO
// -----------------------------------------------------------------------------

const server = http.createServer(app);

server.requestTimeout =
  (appConfig.server && appConfig.server.requestTimeoutMs) || 30000;
server.headersTimeout =
  (appConfig.server && appConfig.server.headersTimeoutMs) || 35000;
// Reduzido para 15s (era 65s) — evita que server.close() fique preso
// à espera de conexões keep-alive durante o graceful shutdown.
server.keepAliveTimeout =
  (appConfig.server && appConfig.server.keepAliveTimeoutMs) || 15000;

// -----------------------------------------------------------------------------
// 2. SOCKET.IO
// -----------------------------------------------------------------------------

const io = new Server(server, {
  cors: corsConfig,
  pingTimeout: 20000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

chatGateway.initialize(io);

// -----------------------------------------------------------------------------
// 3. ESTADO DO PROCESSO E ENCERRAMENTO GRACIOSO
// -----------------------------------------------------------------------------

let isShuttingDown = false;
let isServerListening = false;

/**
 * Encerra o processo de forma controlada.
 * Idempotente: chamadas subsequentes são ignoradas.
 *
 * @param {string} signal
 * @param {number} [exitCode=0]
 */
const gracefulShutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) {
    // Segunda chamada (ex: Ctrl+C duplo) → força encerramento imediato.
    serverLogger.warn(
      `[SERVER:SHUTDOWN] Sinal [${signal}] repetido durante encerramento. Forçando saída imediata.`
    );
    process.exit(1);
    return;
  }
  isShuttingDown = true;

  serverLogger.warn(
    `[SERVER:SHUTDOWN] Sinal [${signal}] recebido. Iniciando encerramento gracioso...`
  );

  const shutdownTimeoutMs =
    (appConfig.server && appConfig.server.shutdownTimeoutMs) || 10000;

  const forceKillTimer = setTimeout(() => {
    serverLogger.fatal(
      '[SERVER:SHUTDOWN] Tempo limite de shutdown excedido. Forçando encerramento imediato.'
    );
    process.exit(1);
  }, shutdownTimeoutMs);

  if (forceKillTimer.unref) forceKillTimer.unref();

  try {
    // 1. Parar jobs (não aceitar novas execuções)
    try {
      runner.stopAllJobs();
    } catch (jobErr) {
      serverLogger.error(
        `[SERVER:SHUTDOWN] Erro ao parar jobs: ${jobErr.message}`
      );
    }

    // 2. Fechar Socket.IO (desconecta clientes em tempo real)
    if (io) {
      try {
        serverLogger.info('[SERVER:SHUTDOWN] Desconectando sockets em tempo real...');
        io.close();
      } catch (ioErr) {
        serverLogger.error(
          `[SERVER:SHUTDOWN] Erro ao fechar Socket.IO: ${ioErr.message}`
        );
      }
    }

    // 3. Fechar servidor HTTP.
    // Só faz sentido se estiver a ouvir — se ainda estiver em arranque,
    // server.close() num servidor "não ouvido" pode comportar-se de forma
    // indefinida.
    if (isServerListening) {
      await new Promise((resolve) => {
        server.close((err) => {
          if (err) {
            serverLogger.error(
              '[SERVER:SHUTDOWN] Erro ao fechar servidor HTTP:',
              err
            );
          } else {
            serverLogger.info(
              '[SERVER:SHUTDOWN] Servidor HTTP parou de aceitar novas requisições.'
            );
          }
          resolve();
        });
      });

      // Fecha conexões keep-alive pendentes (Node 18.2+)
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    } else {
      serverLogger.warn(
        '[SERVER:SHUTDOWN] Servidor HTTP ainda não estava a ouvir — a saltar server.close().'
      );
    }

    // 4. Fechar pool da BD
    try {
      await closePool();
      serverLogger.info('[SERVER:SHUTDOWN] Pool de base de dados encerrado.');
    } catch (poolErr) {
      serverLogger.error(
        `[SERVER:SHUTDOWN] Erro ao fechar pool da BD: ${poolErr.message}`
      );
    }

    clearTimeout(forceKillTimer);
    serverLogger.info(
      '[SERVER:SHUTDOWN] Encerramento gracioso concluído com sucesso.'
    );
    process.exit(exitCode);
  } catch (shutdownError) {
    serverLogger.fatal(
      '[SERVER:SHUTDOWN] Erro fatal durante encerramento gracioso:',
      shutdownError
    );
    clearTimeout(forceKillTimer);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));

process.on('uncaughtException', (err) => {
  serverLogger.fatal(
    `[PROCESS:UNCAUGHT_EXCEPTION] ${err.message}`,
    err
  );
  // Se ainda estamos a arrancar, o startServer vai falhar de qualquer forma.
  // Só encerramos via gracefulShutdown se já estivermos em operação.
  if (isServerListening) {
    gracefulShutdown('uncaughtException', 1);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  serverLogger.error(
    `[PROCESS:UNHANDLED_REJECTION] ${message}`,
    reason instanceof Error ? reason : null
  );

  // Em produção, uma unhandledRejection é grave — encerra para evitar
  // estado inconsistente. Em desenvolvimento, apenas loga.
  if (appConfig.isProduction && isServerListening) {
    gracefulShutdown('unhandledRejection', 1);
  }
});

// -----------------------------------------------------------------------------
// 4. INICIALIZAÇÃO CONTROLADA DA APLICAÇÃO
// -----------------------------------------------------------------------------

const startServer = async () => {
  try {
    serverLogger.info('======================================================');
    const appName =
      typeof appConfig.name === 'string' && appConfig.name.trim().length > 0
        ? appConfig.name
        : 'OneKixikila';
    const currencyCode =
      appConfig.currency && appConfig.currency.code
        ? appConfig.currency.code
        : 'AOA';
    serverLogger.info(`  INICIANDO ${appName.toUpperCase()} (OneKixikila) `);
    serverLogger.info(
      `  Ambiente: [${appConfig.env || env.NODE_ENV}] | Moeda Base: [${currencyCode}]`
    );
    serverLogger.info('======================================================');

    // 1. Verificação de conectividade com o Neon PostgreSQL
    serverLogger.info('[STARTUP:DB] Testando conexão com a base de dados...');
    const dbTest = await testConnection();
    if (!dbTest || typeof dbTest.latencyMs !== 'number') {
      throw new Error(
        '[STARTUP:DB] testConnection devolveu resultado inválido. Verifique database/pool.js.'
      );
    }
    serverLogger.info(
      `[STARTUP:DB] Conexão estabelecida com sucesso. Latência: ${dbTest.latencyMs}ms.`
    );

    // Se o shutdown foi pedido entretanto (SIGTERM/SIGINT durante o arranque),
    // aborta antes de continuar.
    if (isShuttingDown) {
      serverLogger.warn(
        '[STARTUP] Shutdown pedido durante o arranque. Abortando inicialização.'
      );
      return;
    }

    // 2. Migrações
    serverLogger.info('[STARTUP:MIGRATIONS] Verificando esquema e migrações...');
    const migrationResult = await runMigrations();
    serverLogger.info(
      `[STARTUP:MIGRATIONS] Esquema verificado. ${migrationResult.appliedCount} migrações aplicadas.`
    );

    if (isShuttingDown) {
      serverLogger.warn(
        '[STARTUP] Shutdown pedido durante migrações. Abortando inicialização.'
      );
      return;
    }

    // 3. Jobs
    serverLogger.info('[STARTUP:JOBS] Iniciando motor de tarefas periódicas...');
    runner.startAllJobs();

    // 4. Servidor HTTP — ouvir ANTES de qualquer outra operação que dependa de HTTP
    const port = env.PORT ?? appConfig.port ?? 3000;
    await new Promise((resolve, reject) => {
      server.once('error', (listenErr) => reject(listenErr));
      server.listen(port, () => {
        isServerListening = true;
        serverLogger.info(
          `[STARTUP:HTTP] Servidor ativo e pronto a escutar em: ${appConfig.baseUrl} (Porta ${port})`
        );
        serverLogger.info(
          `[STARTUP:HEALTH] Sonda de saúde ativa em: ${appConfig.baseUrl}/api/health`
        );
        resolve();
      });
    });

    // ⚠️ NOTA IMPORTANTE: o listener de AUTH_USER_REGISTERED foi REMOVIDO
    // deste ficheiro. A lógica de notificações de registo (email, SMS, in-app)
    // está centralizada no auth.controller.js (método register), que já cria
    // as notificações e chama o notificationsJob.run().
    //
    // Manter o listener AQUI duplicaria as notificações (o auth.service publica
    // o evento, e o listener criaria notificações adicionais). Quando a
    // arquitetura migrar 100% para eventos, o listener poderá voltar — mas
    // nesse caso o auth.controller.js deixará de criar notificações
    // diretamente.
  } catch (bootError) {
    serverLogger.fatal(
      `[STARTUP:FATAL] Falha catastrófica na inicialização: ${bootError.message}`,
      bootError
    );
    try {
      await closePool();
    } catch (e) {
      // ignora
    }
    process.exit(1);
  }
};

// Garante que qualquer rejeição de startServer seja tratada
startServer().catch((err) => {
  serverLogger.fatal(
    `[STARTUP:FATAL] startServer rejeitou: ${err && err.message ? err.message : String(err)}`,
    err
  );
  process.exit(1);
});