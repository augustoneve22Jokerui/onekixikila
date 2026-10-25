const appConfig = require('../../config/app');

/**
 * Níveis de severidade padronizados de log.
 */
const LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
});

/**
 * Nomes de níveis mapeados para métodos de saída do console.
 */
const LEVEL_NAMES = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL'
});

/**
 * Carrega a função de redação de dados sensíveis de forma resiliente
 * para assegurar desacoplamento e integridade do ciclo de vida.
 */
let redactSensitive;
try {
  const redactionModule = require('./redaction');
  redactSensitive = redactionModule.redactSensitive || redactionModule;
} catch (e) {
  redactSensitive = (data) => data;
}

/**
 * Mecanismo de logging estruturado (JSON em produção) para a plataforma OneKixikila.
 * Garante observabilidade centralizada, correlação via Request-ID, rastreamento de operações
 * financeiras e expurgo estrito de dados sensíveis (senhas, segredos, tokens e dados bancários).
 */
class Logger {
  /**
   * @param {object} [defaultContext={}] - Contexto padrão herdado por todas as mensagens deste logger
   */
  constructor(defaultContext = {}) {
    this.defaultContext = Object.freeze({ ...defaultContext });
    this.currentLevel = appConfig.isProduction ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;
  }

  /**
   * Avalia se determinado nível de severidade deve ser emitido com base no ambiente.
   *
   * @param {number} level
   * @returns {boolean}
   */
  shouldLog(level) {
    return level >= this.currentLevel;
  }

  /**
   * Formata e escreve o registo estruturado na saída padrão correspondente.
   *
   * @param {string} levelName - 'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'
   * @param {string} message - Mensagem descritiva do evento
   * @param {object} [context={}] - Metadados adicionais
   * @param {Error} [error=null] - Instância de erro associada (se houver)
   */
  writeLog(levelName, message, context = {}, error = null) {
    const timestamp = new Date().toISOString();

    // Mescla contexto padrão (ex: module, requestId) com o contexto específico da chamada
    const mergedContext = {
      ...this.defaultContext,
      ...(context && typeof context === 'object' ? context : { data: context })
    };

    // Aplica redação profunda de chaves sensíveis
    const safeContext = redactSensitive(mergedContext);

    const logEntry = {
      timestamp,
      level: levelName,
      env: appConfig.env,
      message,
      ...(safeContext && Object.keys(safeContext).length > 0 ? { context: safeContext } : {})
    };

    if (error instanceof Error) {
      logEntry.error = {
        name: error.name,
        message: error.message,
        code: error.code || error.statusCode || undefined,
        ...(appConfig.isProduction ? {} : { stack: error.stack })
      };
    }

    if (appConfig.isProduction) {
      // Formato JSON estruturado em uma única linha para agregadores de logs do Render
      const serialized = JSON.stringify(logEntry);
      if (levelName === LEVEL_NAMES.ERROR || levelName === LEVEL_NAMES.FATAL) {
        process.stderr.write(`${serialized}\n`);
      } else {
        process.stdout.write(`${serialized}\n`);
      }
    } else {
      // Formato legível e colorido para ambiente de desenvolvimento local
      const modulePrefix = logEntry.context && logEntry.context.module ? `[${logEntry.context.module}] ` : '';
      const reqIdPrefix = logEntry.context && logEntry.context.requestId ? `(Req: ${logEntry.context.requestId}) ` : '';
      const color =
        levelName === LEVEL_NAMES.ERROR || levelName === LEVEL_NAMES.FATAL
          ? '\x1b[31m' // Vermelho
          : levelName === LEVEL_NAMES.WARN
          ? '\x1b[33m' // Amarelo
          : levelName === LEVEL_NAMES.DEBUG
          ? '\x1b[36m' // Ciano
          : '\x1b[32m'; // Verde
      const reset = '\x1b[0m';

      console.log(
        `${color}[${levelName}]${reset} [${timestamp}] ${modulePrefix}${reqIdPrefix}${message}`
      );

      if (logEntry.error && logEntry.error.stack) {
        console.error(logEntry.error.stack);
      }
    }
  }

  /**
   * Registo informativo de baixo nível para depuração em desenvolvimento.
   *
   * @param {string} message
   * @param {object} [context={}]
   */
  debug(message, context = {}) {
    if (this.shouldLog(LOG_LEVELS.DEBUG)) {
      this.writeLog(LEVEL_NAMES.DEBUG, message, context);
    }
  }

  /**
   * Registo de operações normais de ciclo de vida e marcos do sistema.
   *
   * @param {string} message
   * @param {object} [context={}]
   */
  info(message, context = {}) {
    if (this.shouldLog(LOG_LEVELS.INFO)) {
      this.writeLog(LEVEL_NAMES.INFO, message, context);
    }
  }

  /**
   * Registo de situações anómalas, limites atingidos ou advertências recuperáveis.
   *
   * @param {string} message
   * @param {object} [context={}]
   */
  warn(message, context = {}) {
    if (this.shouldLog(LOG_LEVELS.WARN)) {
      this.writeLog(LEVEL_NAMES.WARN, message, context);
    }
  }

  /**
   * Registo de erros operacionais ou exceções tratadas na plataforma.
   *
   * @param {string} message
   * @param {Error|object} [error=null]
   * @param {object} [context={}]
   */
  error(message, error = null, context = {}) {
    if (this.shouldLog(LOG_LEVELS.ERROR)) {
      let errInstance = null;
      let extraContext = context;

      if (error instanceof Error) {
        errInstance = error;
      } else if (error && typeof error === 'object') {
        extraContext = { ...error, ...context };
      }

      this.writeLog(LEVEL_NAMES.ERROR, message, extraContext, errInstance);
    }
  }

  /**
   * Registo de falhas críticas, quebras de invariante contábil ou indisponibilidade de serviços.
   *
   * @param {string} message
   * @param {Error} [error=null]
   * @param {object} [context={}]
   */
  fatal(message, error = null, context = {}) {
    this.writeLog(LEVEL_NAMES.FATAL, message, context, error);
  }

  /**
   * Cria um novo registrador filho (Child Logger) anexando metadados contextuais fixos
   * (ex: nome do módulo, ID de requisição ou identificador pseudonimizado de utilizador).
   *
   * @param {object} childContext - Metadados para anexar (ex: { module: 'WALLETS', requestId: 'req-123' })
   * @returns {Logger} Nova instância com o contexto combinado
   */
  child(childContext = {}) {
    return new Logger({
      ...this.defaultContext,
      ...childContext
    });
  }
}

// Instância principal (Root Logger)
const logger = new Logger({ module: 'core' });

module.exports = logger;