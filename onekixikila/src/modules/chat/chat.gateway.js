// =============================================================================
// modules/chat/chat.gateway.js
// =============================================================================

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
 */
class ChatGateway {
  constructor() {
    this.io = null;
    this.logger = logger.child({ module: 'CHAT_GATEWAY' });
    this.setupEventBusListeners();
  }

  initialize(io) {
    if (!io) {
      throw new Error(
        '[CHAT_GATEWAY] Instância do Socket.IO obrigatória para inicialização do gateway.'
      );
    }

    this.io = io;

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

    this.io.on('connection', (socket) => {
      this.logger.debug(
        `[CHAT_GATEWAY:CONNECT] Utilizador [${socket.user.id}] conectado via socket [${socket.id}].`
      );

      socket.join(`user:${socket.user.id}`);

      socket.on('chat:join_room', async (data, callback) => {
        try {
          const groupId = data?.groupId;

          if (!groupId) {
            if (typeof callback === 'function') {
              callback({ success: false, error: 'MISSING_GROUP_ID' });
            }
            return;
          }

          const canJoin = await this.verifyRoomAccess(socket.user, groupId);
          if (!canJoin) {
            if (typeof callback === 'function') {
              callback({ success: false, error: 'FORBIDDEN_ROOM_ACCESS' });
            }
            return;
          }

          const roomName = `group:${groupId}`;
          await socket.join(roomName);

          this.logger.debug(
            `[CHAT_GATEWAY:JOIN] Utilizador [${socket.user.id}] entrou na sala [${roomName}].`
          );

          if (typeof callback === 'function') {
            callback({ success: true, room: roomName });
          }
        } catch (joinError) {
          this.logger.error(`[CHAT_GATEWAY:JOIN_ERROR] ${joinError.message}`, joinError);
          if (typeof callback === 'function') {
            callback({ success: false, error: 'INTERNAL_ERROR' });
          }
        }
      });

      socket.on('chat:leave_room', (data) => {
        const groupId = data?.groupId;
        if (groupId) {
          socket.leave(`group:${groupId}`);
        }
      });

      socket.on('chat:send_message', async (data, callback) => {
        try {
          const { groupId, content, clientMessageId } = data || {};

          if (!groupId || !content) {
            if (typeof callback === 'function') {
              callback({ success: false, error: 'INVALID_PAYLOAD' });
            }
            return;
          }

          if (!(await this.verifyJoinedRoomAccess(socket, groupId))) {
            if (typeof callback === 'function') {
              callback({ success: false, error: 'FORBIDDEN_ROOM_ACCESS' });
            }
            return;
          }

          const savedMessage = await textMessageService.sendTextMessage(
            { id: socket.user.id, role: socket.user.role },
            groupId,
            { content, clientMessageId }
          );

          this.io.to(`group:${groupId}`).emit('chat:new_message', savedMessage);

          if (typeof callback === 'function') {
            callback({ success: true, message: savedMessage });
          }
        } catch (sendError) {
          this.logger.warn(`[CHAT_GATEWAY:SEND_ERROR] Falha ao enviar mensagem: ${sendError.message}`);
          if (typeof callback === 'function') {
            callback({
              success: false,
              error: sendError.message,
              code: sendError.code || 'SEND_FAILED'
            });
          }
        }
      });

      socket.on('chat:typing_start', async (data) => {
        const groupId = data?.groupId;
        if (!groupId) return;

        try {
          if (!(await this.verifyJoinedRoomAccess(socket, groupId))) return;

          socket.to(`group:${groupId}`).emit('chat:user_typing', {
            groupId,
            userId: socket.user.id
          });
        } catch (error) {
          this.logger.debug(`[CHAT_GATEWAY:TYPING_START_ERROR] ${error.message}`);
        }
      });

      socket.on('chat:typing_stop', async (data) => {
        const groupId = data?.groupId;
        if (!groupId) return;

        try {
          if (!(await this.verifyJoinedRoomAccess(socket, groupId))) return;

          socket.to(`group:${groupId}`).emit('chat:user_stopped_typing', {
            groupId,
            userId: socket.user.id
          });
        } catch (error) {
          this.logger.debug(`[CHAT_GATEWAY:TYPING_STOP_ERROR] ${error.message}`);
        }
      });

      socket.on('chat:mark_read', async (data) => {
        try {
          const { messageId, groupId } = data || {};
          if (!messageId || !groupId) return;

          if (!(await this.verifyJoinedRoomAccess(socket, groupId))) return;

          const message = await chatRepository.findById(messageId);
          if (!message || String(message.group_id) !== String(groupId)) return;

          const receipt = await chatRepository.upsertReceipt(messageId, socket.user.id, true);

          socket.to(`group:${groupId}`).emit('chat:receipt_updated', {
            messageId,
            userId: socket.user.id,
            readAt: receipt.read_at
          });
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

  async verifyRoomAccess(user, groupId) {
    if (!user || !user.id || !groupId) {
      return false;
    }

    if (user.role === 'ADMIN' || user.role === 'AUDITOR') {
      return true;
    }

    const group = await groupsRepository.findById(groupId);
    if (!group || group.status === 'CANCELLED') {
      return false;
    }

    if (String(group.leader_id) === String(user.id) || String(group.creator_id) === String(user.id)) {
      return true;
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, user.id);
    return Boolean(membership && membership.status === 'ACTIVE');
  }

  async verifyJoinedRoomAccess(socket, groupId) {
    const roomName = `group:${groupId}`;
    const hasAccess = await this.verifyRoomAccess(socket.user, groupId);

    if (!hasAccess) {
      if (socket.rooms.has(roomName)) {
        await socket.leave(roomName);
      }
      return false;
    }

    return socket.rooms.has(roomName);
  }

  /**
   * Retira imediatamente da sala os sockets de um utilizador cuja filiação
   * deixou de permitir acesso ao chat.
   */
  revokeUserRoomAccess(payload, reason) {
    if (!this.io || !payload?.groupId || !payload?.userId) {
      return;
    }

    const roomName = `group:${payload.groupId}`;
    const userRoomName = `user:${payload.userId}`;

    this.io.in(userRoomName).socketsLeave(roomName);
    this.io.to(userRoomName).emit('chat:access_revoked', {
      groupId: payload.groupId,
      reason
    });
  }

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

    eventBus.subscribe(EVENT_TYPES.GROUP_MEMBERSHIP_SUSPENDED, (envelope) => {
      this.revokeUserRoomAccess(envelope?.payload, 'MEMBERSHIP_SUSPENDED');
    });

    eventBus.subscribe(EVENT_TYPES.GROUP_MEMBERSHIP_LEFT, (envelope) => {
      this.revokeUserRoomAccess(envelope?.payload, 'MEMBERSHIP_LEFT');
    });
  }

  broadcastToGroup(groupId, eventName, payload) {
    if (this.io && groupId) {
      this.io.to(`group:${groupId}`).emit(eventName, payload);
    }
  }

  broadcastToUser(userId, eventName, payload) {
    if (this.io && userId) {
      this.io.to(`user:${userId}`).emit(eventName, payload);
    }
  }
}

const chatGateway = new ChatGateway();

module.exports = chatGateway;
