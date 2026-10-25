const tokenSecurity = require('../../shared/security/tokens');
const chatRepository = require('./chat.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const groupsRepository = require('../groups/groups.repository');
const textMessageService = require('./text-message.service');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const logger = require('../../shared/logging/logger');

/**
 * Gateway de comunicação em tempo real (WebSockets via Socket.IO) para os Grupos de Kixikila.
 * Gerencia a autenticação criptográfica no handshake, isolamento de salas por grupo (rooms),
 * autorização estrita de entrada baseada em filiação ativa no PostgreSQL, sincronização de digitação,
 * entrega bidirecional de mensagens e difusão de recibos de leitura.
 */
class ChatGateway {
  constructor() {
    this.io = null;
    this.logger = logger.child({ module: 'CHAT_GATEWAY' });
    this.setupEventBusListeners();
  }

  /**
   * Inicializa o gateway com a instância global do Socket.IO do servidor HTTP.
   *
   * @param {import('socket.io').Server} io
   */
  initialize(io) {
    if (!io) {
      throw new Error('[CHAT_GATEWAY] Instância do Socket.IO obrigatória para inicialização do gateway.');
    }

    this.io = io;

    // 1. Middleware de Autenticação no Handshake do WebSocket
    this.io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
          socket.handshake.headers?.cookie
            ?.split('; ')
            .find((row) => row.startsWith('onekixikila_token='))
            ?.split('=')[1];

        if (!token) {
          return next(new Error('AUTHENTICATION_REQUIRED'));
        }

        const decoded = tokenSecurity.verifyAccessToken(token);

        socket.user = {
          id: decoded.sub,
          role: decoded.role,
          sessionId: decoded.sessionId || null
        };

        return next();
      } catch (authError) {
        this.logger.warn(`[CHAT_GATEWAY:AUTH_FAILED] Conexão rejeitada: ${authError.message}`);
        return next(new Error('INVALID_TOKEN'));
      }
    });

    // 2. Conexão e Registo de Eventos de Socket
    this.io.on('connection', (socket) => {
      this.logger.debug(`[CHAT_GATEWAY:CONNECT] Utilizador [${socket.user.id}] conectado via socket [${socket.id}].`);

      // Canal individual do utilizador para avisos e notificações direcionadas
      socket.join(`user:${socket.user.id}`);

      // Evento: Entrada em sala de grupo de Kixikila
      socket.on('chat:join_room', async (data, callback) => {
        try {
          const groupId = data?.groupId;
          if (!groupId) {
            if (typeof callback === 'function') callback({ success: false, error: 'MISSING_GROUP_ID' });
            return;
          }

          const canJoin = await this.verifyRoomAccess(socket.user, groupId);
          if (!canJoin) {
            if (typeof callback === 'function') callback({ success: false, error: 'FORBIDDEN_ROOM_ACCESS' });
            return;
          }

          const roomName = `group:${groupId}`;
          socket.join(roomName);

          this.logger.debug(`[CHAT_GATEWAY:JOIN] Utilizador [${socket.user.id}] entrou na sala [${roomName}].`);

          if (typeof callback === 'function') {
            callback({ success: true, room: roomName });
          }
        } catch (joinError) {
          this.logger.error(`[CHAT_GATEWAY:JOIN_ERROR] ${joinError.message}`, joinError);
          if (typeof callback === 'function') callback({ success: false, error: 'INTERNAL_ERROR' });
        }
      });

      // Evento: Saída da sala de grupo
      socket.on('chat:leave_room', (data) => {
        const groupId = data?.groupId;
        if (groupId) {
          socket.leave(`group:${groupId}`);
        }
      });

      // Evento: Envio de mensagem de texto em tempo real com persistência garantida
      socket.on('chat:send_message', async (data, callback) => {
        try {
          const { groupId, content, clientMessageId } = data || {};
          if (!groupId || !content) {
            if (typeof callback === 'function') callback({ success: false, error: 'INVALID_PAYLOAD' });
            return;
          }

          const savedMessage = await textMessageService.sendTextMessage(
            { id: socket.user.id, role: socket.user.role },
            groupId,
            { content, clientMessageId }
          );

          // Difusão imediata para todos os participantes na sala do grupo
          this.io.to(`group:${groupId}`).emit('chat:new_message', savedMessage);

          if (typeof callback === 'function') {
            callback({ success: true, message: savedMessage });
          }
        } catch (sendError) {
          this.logger.warn(`[CHAT_GATEWAY:SEND_ERROR] Falha ao enviar mensagem: ${sendError.message}`);
          if (typeof callback === 'function') {
            callback({ success: false, error: sendError.message, code: sendError.code || 'SEND_FAILED' });
          }
        }
      });

      // Evento: Indicador de digitação (Typing Indicator)
      socket.on('chat:typing_start', (data) => {
        const groupId = data?.groupId;
        if (groupId) {
          socket.to(`group:${groupId}`).emit('chat:user_typing', {
            groupId,
            userId: socket.user.id
          });
        }
      });

      socket.on('chat:typing_stop', (data) => {
        const groupId = data?.groupId;
        if (groupId) {
          socket.to(`group:${groupId}`).emit('chat:user_stopped_typing', {
            groupId,
            userId: socket.user.id
          });
        }
      });

      // Evento: Confirmação de leitura de mensagem (Read Receipt)
      socket.on('chat:mark_read', async (data) => {
        try {
          const { messageId, groupId } = data || {};
          if (messageId && groupId) {
            await chatRepository.upsertReceipt(messageId, socket.user.id, true);
            socket.to(`group:${groupId}`).emit('chat:receipt_updated', {
              messageId,
              userId: socket.user.id,
              readAt: new Date().toISOString()
            });
          }
        } catch (receiptError) {
          this.logger.debug(`[CHAT_GATEWAY:RECEIPT_ERROR] ${receiptError.message}`);
        }
      });

      socket.on('disconnect', () => {
        this.logger.debug(`[CHAT_GATEWAY:DISCONNECT] Socket [${socket.id}] desconectado.`);
      });
    });

    this.logger.info('[CHAT_GATEWAY] Gateway de tempo real ativado com sucesso.');
  }

  /**
   * Valida se determinado utilizador detém autorização para aceder à sala de conversação privada do grupo.
   *
   * @param {object} user - Utilizador do socket
   * @param {string} groupId - UUID do grupo
   * @returns {Promise<boolean>}
   */
  async verifyRoomAccess(user, groupId) {
    if (user.role === 'ADMIN' || user.role === 'AUDITOR') {
      return true;
    }

    const group = await groupsRepository.findById(groupId);
    if (!group || group.status === 'CANCELLED') {
      return false;
    }

    if (group.leader_id === user.id || group.creator_id === user.id) {
      return true;
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, user.id);
    return Boolean(membership && membership.status === 'ACTIVE');
  }

  /**
   * Conecta o barramento assíncrono de eventos de domínio aos canais de difusão do Socket.IO.
   * Garante entrega em tempo real mesmo quando mensagens são criadas por serviços REST ou tarefas.
   */
  setupEventBusListeners() {
    eventBus.subscribe(EVENT_TYPES.CHAT_TEXT_MESSAGE_SENT, (envelope) => {
      if (this.io && envelope.payload?.groupId) {
        this.io.to(`group:${envelope.payload.groupId}`).emit('chat:new_message', envelope.payload);
      }
    });

    eventBus.subscribe(EVENT_TYPES.CHAT_AUDIO_MESSAGE_SENT, (envelope) => {
      if (this.io && envelope.payload?.groupId) {
        this.io.to(`group:${envelope.payload.groupId}`).emit('chat:new_audio', envelope.payload);
      }
    });

    eventBus.subscribe(EVENT_TYPES.CHAT_DOCUMENT_SENT, (envelope) => {
      if (this.io && envelope.payload?.groupId) {
        this.io.to(`group:${envelope.payload.groupId}`).emit('chat:new_document', envelope.payload);
      }
    });

    eventBus.subscribe(EVENT_TYPES.CHAT_MESSAGE_DELETED, (envelope) => {
      if (this.io && envelope.payload?.groupId) {
        this.io.to(`group:${envelope.payload.groupId}`).emit('chat:message_deleted', envelope.payload);
      }
    });
  }

  /**
   * Emite uma notificação em tempo real diretamente para a sala de um grupo.
   *
   * @param {string} groupId
   * @param {string} eventName
   * @param {object} payload
   */
  broadcastToGroup(groupId, eventName, payload) {
    if (this.io) {
      this.io.to(`group:${groupId}`).emit(eventName, payload);
    }
  }

  /**
   * Emite uma notificação direcionada exclusivamente para a conexão de um utilizador específico.
   *
   * @param {string} userId
   * @param {string} eventName
   * @param {object} payload
   */
  broadcastToUser(userId, eventName, payload) {
    if (this.io) {
      this.io.to(`user:${userId}`).emit(eventName, payload);
    }
  }
}

// Instância singleton do gateway de chat
const chatGateway = new ChatGateway();

module.exports = chatGateway;