const EventEmitter = require('events');
const crypto = require('crypto');
const logger = require('../logging/logger');

/**
 * Barramento de eventos em memória (In-Process Event Bus) assíncrono para a plataforma OneKixikila.
 * Desacopla a execução das mutações de domínio (transações contábeis, liquidações de grupos e aprovações KYC)
 * dos respetivos efeitos colaterais (envio de notificações SMS, e-mails, alertas em tempo real e auditoria técnica).
 *
 * Garante isolamento de falhas: o insucesso no processamento de um ouvinte nunca corrompe
 * nem aborta o fluxo da transação principal.
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    // Aumenta o limite padrão de ouvintes para acomodar múltiplos serviços de reação
    this.setMaxListeners(50);
    this.logger = logger.child({ module: 'EVENT_BUS' });
  }

  /**
   * Publica um evento de domínio de forma segura e não bloqueante (Fire-and-Forget).
   * Encapsula o payload com identificador de evento único (UUID) e carimbo de data/hora UTC.
   *
   * @param {string} eventType - Nome do evento (canónico de EVENT_TYPES)
   * @param {object} payload - Dados específicos do evento
   * @param {object} [metadata={}] - Metadados adicionais (ex: actorUserId, requestId)
   * @returns {string} Identificador único do evento gerado (eventId)
   */
  publish(eventType, payload = {}, metadata = {}) {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const eventEnvelope = Object.freeze({
      eventId,
      eventType,
      timestamp,
      payload: Object.freeze({ ...payload }),
      metadata: Object.freeze({ ...metadata })
    });

    this.logger.debug(`[EVENT:PUBLISH] Disparando evento [${eventType}] (ID: ${eventId})`);

    // Emite o evento na próxima iteração do event loop para não bloquear a resposta imediata
    setImmediate(() => {
      try {
        this.emit(eventType, eventEnvelope);
      } catch (emitError) {
        this.logger.error(`[EVENT:EMIT_ERROR] Falha síncrona ao emitir evento [${eventType}]:`, emitError, {
          eventId
        });
      }
    });

    return eventId;
  }

  /**
   * Publica um evento e aguarda a conclusão assíncrona de todos os ouvintes registados
   * utilizando Promise.allSettled para garantir que falhas individuais não interrompam os demais.
   *
   * @param {string} eventType
   * @param {object} payload
   * @param {object} [metadata={}]
   * @returns {Promise<{ eventId: string, results: Array<PromiseSettledResult<any>> }>}
   */
  async publishAsync(eventType, payload = {}, metadata = {}) {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const eventEnvelope = Object.freeze({
      eventId,
      eventType,
      timestamp,
      payload: Object.freeze({ ...payload }),
      metadata: Object.freeze({ ...metadata })
    });

    this.logger.debug(`[EVENT:PUBLISH_ASYNC] Disparando evento assíncrono [${eventType}] (ID: ${eventId})`);

    const listeners = this.rawListeners(eventType);
    if (listeners.length === 0) {
      return { eventId, results: [] };
    }

    const handlerPromises = listeners.map(async (listener) => {
      try {
        return await listener(eventEnvelope);
      } catch (handlerError) {
        this.logger.error(
          `[EVENT:HANDLER_ERROR] Falha em ouvinte de [${eventType}] (EventID: ${eventId}):`,
          handlerError,
          { eventId, eventType }
        );
        throw handlerError;
      }
    });

    const results = await Promise.allSettled(handlerPromises);
    return { eventId, results };
  }

  /**
   * Regista um ouvinte assíncrono seguro que isola e faz o log de qualquer exceção não tratada.
   *
   * @param {string} eventType
   * @param {(event: { eventId: string, eventType: string, timestamp: string, payload: any, metadata: any }) => Promise<void>|void} handler
   */
  subscribe(eventType, handler) {
    const safeWrapper = async (envelope) => {
      try {
        await handler(envelope);
      } catch (error) {
        this.logger.error(
          `[EVENT:LISTENER_FAILED] Exceção capturada no handler do evento [${eventType}]:`,
          error,
          {
            eventId: envelope.eventId,
            eventType
          }
        );
      }
    };

    // Mapeia o wrapper para permitir cancelamento futuro se necessário
    handler._safeWrapper = safeWrapper;
    this.on(eventType, safeWrapper);
  }

  /**
   * Remove a subscrição de um ouvinte previamente registado.
   *
   * @param {string} eventType
   * @param {Function} handler
   */
  unsubscribe(eventType, handler) {
    const wrapper = handler._safeWrapper || handler;
    this.off(eventType, wrapper);
  }

  /**
   * Remove todos os ouvintes associados aos eventos da plataforma (útil para encerramento gracioso).
   */
  clearAll() {
    this.removeAllListeners();
    this.logger.info('[EVENT_BUS] Todos os ouvintes do barramento foram desanexados.');
  }
}

// Instância singleton do barramento de eventos
const eventBus = new EventBus();

module.exports = eventBus;