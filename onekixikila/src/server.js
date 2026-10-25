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

// Configuração de timeouts operacionais da conexão HTTP (prevenção contra ataques slowloris)
server.requestTimeout = appConfig.server.requestTimeoutMs || 30000;
server.headersTimeout = appConfig.server.headersTimeoutMs || 35000;
server.keepAliveTimeout = appConfig.server.keepAliveTimeoutMs || 65000;

// -----------------------------------------------------------------------------
// 2. CONFIGURAÇÃO DO SOCKET.IO (Comunicação em Tempo Real do Chat)
// -----------------------------------------------------------------------------

const io = new Server(server, {
  cors: corsConfig,
  pingTimeout: 20000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Inicialização do Gateway de WebSockets com isolamento de salas e autenticação JWT
chatGateway.initialize(io);

// -----------------------------------------------------------------------------
// 3. ROTINAS DE ENCERRAMENTO GRACIOSO (Graceful Shutdown)
// -----------------------------------------------------------------------------

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  serverLogger.warn(`[SERVER:SHUTDOWN] Sinal [${signal}] recebido. Iniciando encerramento gracioso...`);

  // Define um timer de segurança forçado para evitar travamentos indefinidos
  const forceKillTimer = setTimeout(() => {
    serverLogger.fatal('[SERVER:SHUTDOWN] Tempo limite de shutdown excedido. Forçando encerramento imediato do processo.');
    process.exit(1);
  }, appConfig.server.shutdownTimeoutMs || 10000);

  // Evita que o temporizador de segurança impeça a saída limpa
  if (forceKillTimer.unref) {
    forceKillTimer.unref();
  }

  try {
    // 1. Interrompe todas as tarefas agendadas em segundo plano e cancela timers
    runner.stopAllJobs();

    // 2. Encerra conexões ativas de WebSockets
    if (io) {
      serverLogger.info('[SERVER:SHUTDOWN] Desconectando sockets em tempo real...');
      io.close();
    }

    // 3. Pára de aceitar novas requisições HTTP e conclui as em processamento
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          serverLogger.error('[SERVER:SHUTDOWN] Erro ao fechar servidor HTTP:', err);
        } else {
          serverLogger.info('[SERVER:SHUTDOWN] Servidor HTTP parou de aceitar novas requisições.');
        }
        resolve();
      });
    });

    // 4. Encerra o pool de conexões do Neon PostgreSQL
    await closePool();

    clearTimeout(forceKillTimer);
    serverLogger.info('[SERVER:SHUTDOWN] Encerramento gracioso concluído com sucesso. Processo finalizado.');
    process.exit(0);
  } catch (shutdownError) {
    serverLogger.fatal('[SERVER:SHUTDOWN] Erro fatal durante encerramento gracioso:', shutdownError);
    clearTimeout(forceKillTimer);
    process.exit(1);
  }
};

// Escuta sinais de término emitidos pelo sistema operacional e orquestradores (Render)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Captura de exceções não tratadas e rejeições de promises
process.on('uncaughtException', (err) => {
  serverLogger.fatal(`[PROCESS:UNCAUGHT_EXCEPTION] ${err.message}`, err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  serverLogger.error(`[PROCESS:UNHANDLED_REJECTION] ${message}`, reason instanceof Error ? reason : null);
});

// -----------------------------------------------------------------------------
// 4. INICIALIZAÇÃO CONTROLADA DA APLICAÇÃO
// -----------------------------------------------------------------------------

const startServer = async () => {
  try {
    serverLogger.info('======================================================');
    serverLogger.info(`  INICIANDO ${appConfig.name.toUpperCase()} (OneKixikila) `);
    serverLogger.info(`  Ambiente: [${appConfig.env}] | Moeda Base: [${appConfig.currency.code}]`);
    serverLogger.info('======================================================');

    // 1. Verificação ativa de conectividade com o Neon PostgreSQL
    serverLogger.info('[STARTUP:DB] Testando conexão com a base de dados...');
    const dbTest = await testConnection();
    serverLogger.info(`[STARTUP:DB] Conexão estabelecida com sucesso. Latência: ${dbTest.latencyMs}ms.`);

    // 2. Execução controlada de migrações SQL pendentes protegidas por advisory lock
    serverLogger.info('[STARTUP:MIGRATIONS] Verificando esquema e migrações...');
    const migrationResult = await runMigrations();
    serverLogger.info(`[STARTUP:MIGRATIONS] Esquema verificado. ${migrationResult.appliedCount} migrações aplicadas.`);

    // 3. Inicialização do agendador distribuído de tarefas em segundo plano
    serverLogger.info('[STARTUP:JOBS] Iniciando motor de tarefas periódicas...');
    runner.startAllJobs();

    // 4. Abertura do socket de escuta na porta configurada
    const port = env.PORT || appConfig.port || 3000;
    server.listen(port, () => {
      serverLogger.info(`[STARTUP:HTTP] Servidor ativo e pronto a escutar em: ${appConfig.baseUrl} (Porta ${port})`);
      serverLogger.info(`[STARTUP:HEALTH] Sonda de saúde ativa em: ${appConfig.baseUrl}/api/health`);
    });
  } catch (bootError) {
    serverLogger.fatal(`[STARTUP:FATAL] Falha catastrófica na inicialização: ${bootError.message}`, bootError);
    await closePool();
    process.exit(1);
  }
};

startServer();