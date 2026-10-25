/**
 * ONEKIXIKILA — GESTOR DO CHAT E COMUNICAÇÃO DE GRUPOS (Vanilla JS / Browser)
 * Controla a comunicação em tempo real via Socket.IO e fallback REST,
 * renderização cronológica de mensagens de texto, notas de voz, anexos até 5 MB,
 * avisos fixados, confirmação de leitura, indicadores de digitação e moderação.
 */

(function (window, document) {
  'use strict';

  class ChatManager {
    constructor() {
      this.socket = null;
      this.groupId = null;
      this.currentUserId = null;
      this.isLeaderOrAdmin = false;
      this.isConnected = false;
      this.typingTimeout = null;
      this.isTyping = false;
      this.oldestMessageDate = null;
      this.hasMoreMessages = true;
      this.isLoadingOlder = false;

      // Elementos do DOM
      this.container = null;
      this.messagesList = null;
      this.messageInput = null;
      this.sendBtn = null;
      this.pinnedContainer = null;
      this.typingIndicator = null;
      this.scrollBottomBtn = null;
    }

    /**
     * Inicializa a interface e a conexão em tempo real do chat do grupo.
     * @param {object} options
     * @param {string} options.groupId
     * @param {string} options.currentUserId
     * @param {boolean} [options.isLeaderOrAdmin=false]
     */
    init(options = {}) {
      this.groupId = options.groupId || document.querySelector('[data-chat-group-id]')?.getAttribute('data-chat-group-id');
      if (!this.groupId) return;

      this.currentUserId = options.currentUserId || this.resolveCurrentUserId();
      this.isLeaderOrAdmin = Boolean(options.isLeaderOrAdmin || document.querySelector('[data-is-leader-or-admin="true"]'));

      this.bindDOMElements();
      if (!this.messagesList || !this.messageInput) return;

      this.bindEvents();
      this.initSocketConnection();
      this.loadInitialMessages();
      this.loadPinnedMessages();
    }

    /**
     * Tenta identificar o ID do utilizador ativo a partir do localStorage ou da sessão
     * @returns {string|null}
     */
    resolveCurrentUserId() {
      try {
        const storedUser = window.localStorage.getItem('onekixikila_user');
        if (storedUser) {
          const parsed = JSON.parse(storedUser);
          return parsed.id || null;
        }
      } catch (e) {}
      const userMeta = document.querySelector('meta[name="current-user-id"]');
      return userMeta ? userMeta.getAttribute('content') : null;
    }

    /**
     * Localiza os elementos da interface no DOM
     */
    bindDOMElements() {
      this.container = document.querySelector('#chat-container');
      this.messagesList = document.querySelector('#chat-messages-list');
      this.messageInput = document.querySelector('#chat-message-input');
      this.sendBtn = document.querySelector('#chat-send-btn');
      this.pinnedContainer = document.querySelector('#chat-pinned-banner');
      this.typingIndicator = document.querySelector('#chat-typing-indicator');
      this.scrollBottomBtn = document.querySelector('#chat-scroll-bottom-btn');
    }

    /**
     * Regista ouvintes de eventos da interface
     */
    bindEvents() {
      // Envio de texto ao submeter formulário ou pressionar Enter
      const form = document.querySelector('#chat-input-form');
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleSendMessage();
        });
      }

      if (this.messageInput) {
        this.messageInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendMessage();
          } else {
            this.handleTyping();
          }
        });
      }

      // Detecção de rolagem para carregamento de mensagens anteriores
      if (this.messagesList) {
        this.messagesList.addEventListener('scroll', () => {
          if (this.messagesList.scrollTop === 0 && this.hasMoreMessages && !this.isLoadingOlder) {
            this.loadOlderMessages();
          }

          // Exibe botão de rolar para o fundo se o utilizador subiu a conversa
          const isNearBottom = this.messagesList.scrollHeight - this.messagesList.scrollTop - this.messagesList.clientHeight < 120;
          if (this.scrollBottomBtn) {
            this.scrollBottomBtn.classList.toggle('d-none', isNearBottom);
          }
        });
      }

      if (this.scrollBottomBtn) {
        this.scrollBottomBtn.addEventListener('click', () => this.scrollToBottom(true));
      }

      // Ações delegadas em mensagens (eliminar, fixar, denunciar)
      if (this.messagesList) {
        this.messagesList.addEventListener('click', (e) => {
          const deleteBtn = e.target.closest('[data-chat-action="delete"]');
          if (deleteBtn) {
            e.preventDefault();
            const messageId = deleteBtn.getAttribute('data-message-id');
            if (messageId) this.deleteMessage(messageId);
            return;
          }

          const pinBtn = e.target.closest('[data-chat-action="pin"]');
          if (pinBtn) {
            e.preventDefault();
            const messageId = pinBtn.getAttribute('data-message-id');
            const isCurrentlyPinned = pinBtn.getAttribute('data-pinned') === 'true';
            if (messageId) this.togglePinMessage(messageId, !isCurrentlyPinned);
            return;
          }

          const reportBtn = e.target.closest('[data-chat-action="report"]');
          if (reportBtn) {
            e.preventDefault();
            const messageId = reportBtn.getAttribute('data-message-id');
            if (messageId) this.reportMessage(messageId);
          }
        });
      }
    }

    /**
     * Inicializa o canal bidirecional Socket.IO com autenticação e junção de sala
     */
    initSocketConnection() {
      if (typeof window.io === 'undefined') {
        // Fallback: opera exclusivamente com REST caso Socket.IO não esteja presente
        return;
      }

      const token = window.apiClient ? window.apiClient.getAccessToken() : null;

      this.socket = window.io({
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000
      });

      this.socket.on('connect', () => {
        this.isConnected = true;
        this.socket.emit('chat:join_room', { groupId: this.groupId }, (ack) => {
          if (ack && !ack.success) {
            if (window.Alerts) window.Alerts.error('Acesso à sala de conversação negado.');
          }
        });
      });

      this.socket.on('disconnect', () => {
        this.isConnected = false;
      });

      // Receção de nova mensagem de texto
      this.socket.on('chat:new_message', (message) => {
        if (!message || message.groupId !== this.groupId && message.group_id !== this.groupId) return;
        this.appendMessage(message);
        this.markMessageAsRead(message.id || message.messageId);
      });

      // Receção de nova nota de voz
      this.socket.on('chat:new_audio', (message) => {
        if (!message || message.groupId !== this.groupId && message.group_id !== this.groupId) return;
        this.appendMessage(message);
        this.markMessageAsRead(message.id || message.messageId);
      });

      // Receção de novo documento anexo
      this.socket.on('chat:new_document', (message) => {
        if (!message || message.groupId !== this.groupId && message.group_id !== this.groupId) return;
        this.appendMessage(message);
        this.markMessageAsRead(message.id || message.messageId);
      });

      // Mensagem eliminada
      this.socket.on('chat:message_deleted', (payload) => {
        if (!payload || payload.groupId !== this.groupId) return;
        this.handleMessageDeletedUI(payload.messageId);
      });

      // Aviso fixado atualizado
      this.socket.on('chat:pin_updated', () => {
        this.loadPinnedMessages();
      });

      // Indicadores de digitação
      this.socket.on('chat:user_typing', (data) => {
        if (!data || data.groupId !== this.groupId || data.userId === this.currentUserId) return;
        this.showTypingIndicator();
      });

      this.socket.on('chat:user_stopped_typing', (data) => {
        if (!data || data.groupId !== this.groupId || data.userId === this.currentUserId) return;
        this.hideTypingIndicator();
      });
    }

    /**
     * Carrega o histórico inicial de mensagens via API REST
     */
    async loadInitialMessages() {
      try {
        if (!window.apiClient) return;
        const res = await window.apiClient.get(`/chat/groups/${this.groupId}/messages?limit=50`);
        const messages = res.data || [];

        if (this.messagesList) {
          this.messagesList.innerHTML = '';
        }

        if (messages.length === 0) {
          this.renderEmptyState();
          return;
        }

        // As mensagens vêm em ordem decrescente (ORDER BY created_at DESC)
        // Inverte para exibir cronologicamente do topo para o fundo
        const chronological = [...messages].reverse();
        chronological.forEach((msg) => this.appendMessage(msg, false));

        this.oldestMessageDate = messages[messages.length - 1].created_at;
        this.hasMoreMessages = messages.length >= 50;

        this.scrollToBottom(false);

        // Confirma leitura da mensagem mais recente
        const latest = chronological[chronological.length - 1];
        if (latest && latest.id) {
          this.markMessageAsRead(latest.id);
        }
      } catch (err) {
        if (this.messagesList) {
          this.messagesList.innerHTML = `
            <div class="text-center p-4 text-muted">
              <i class="bi bi-exclamation-triangle fs-3 text-warning"></i>
              <p class="small mt-2">Falha ao carregar as mensagens da conversa.</p>
            </div>
          `;
        }
      }
    }

    /**
     * Carrega mensagens anteriores para paginação infinita para o topo
     */
    async loadOlderMessages() {
      if (!this.oldestMessageDate || this.isLoadingOlder || !this.hasMoreMessages) return;

      this.isLoadingOlder = true;
      const prevScrollHeight = this.messagesList.scrollHeight;

      try {
        const res = await window.apiClient.get(
          `/chat/groups/${this.groupId}/messages?limit=30&before=${encodeURIComponent(this.oldestMessageDate)}`
        );
        const olderMessages = res.data || [];

        if (olderMessages.length === 0) {
          this.hasMoreMessages = false;
          return;
        }

        const chronological = [...olderMessages].reverse();
        chronological.forEach((msg) => {
          const msgEl = this.buildMessageElement(msg);
          this.messagesList.insertBefore(msgEl, this.messagesList.firstChild);
        });

        this.oldestMessageDate = olderMessages[olderMessages.length - 1].created_at;
        this.hasMoreMessages = olderMessages.length >= 30;

        // Mantém a posição de rolagem relativa estável
        const newScrollHeight = this.messagesList.scrollHeight;
        this.messagesList.scrollTop = newScrollHeight - prevScrollHeight;
      } catch (err) {
        // Falha silenciosa de paginação
      } finally {
        this.isLoadingOlder = false;
      }
    }

    /**
     * Consulta e apresenta avisos fixados no topo da sala
     */
    async loadPinnedMessages() {
      if (!this.pinnedContainer || !window.apiClient) return;

      try {
        const res = await window.apiClient.get(`/chat/groups/${this.groupId}/messages/pinned`);
        const pinned = res.data && res.data.pinnedMessages ? res.data.pinnedMessages : [];

        if (pinned.length === 0) {
          this.pinnedContainer.classList.add('d-none');
          this.pinnedContainer.innerHTML = '';
          return;
        }

        const latestPinned = pinned[0];
        this.pinnedContainer.innerHTML = `
          <div class="alert alert-primary d-flex align-items-center justify-content-between p-2 mb-0 shadow-sm border-0 rounded-0">
            <div class="d-flex align-items-center overflow-hidden me-2">
              <i class="bi bi-pin-angle-fill me-2 fs-5 text-primary"></i>
              <div class="text-truncate small">
                <strong>Aviso de ${this.escapeHtml(latestPinned.sender_name || 'Liderança')}:</strong>
                <span>${this.escapeHtml(latestPinned.content || 'Mensagem fixada')}</span>
              </div>
            </div>
            ${this.isLeaderOrAdmin ? `
              <button class="btn btn-sm btn-link text-muted p-0 text-decoration-none" data-chat-action="pin" data-message-id="${latestPinned.id}" data-pinned="true" title="Desafixar aviso">
                <i class="bi bi-x-circle"></i>
              </button>
            ` : ''}
          </div>
        `;
        this.pinnedContainer.classList.remove('d-none');
      } catch (e) {
        this.pinnedContainer.classList.add('d-none');
      }
    }

    /**
     * Processa e despacha o envio de uma mensagem textual
     */
    async handleSendMessage() {
      if (!this.messageInput) return;
      const content = this.messageInput.value.trim();
      if (!content) return;

      const clientMessageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Limpa a caixa de entrada imediatamente e reseta indicador de digitação
      this.messageInput.value = '';
      this.stopTyping();

      // Envio em tempo real com fallback REST
      if (this.socket && this.isConnected) {
        this.socket.emit(
          'chat:send_message',
          {
            groupId: this.groupId,
            content,
            clientMessageId
          },
          (ack) => {
            if (ack && !ack.success) {
              this.fallbackSendRest(content, clientMessageId);
            }
          }
        );
      } else {
        await this.fallbackSendRest(content, clientMessageId);
      }
    }

    /**
     * Fallback de envio via API REST
     * @param {string} content
     * @param {string} clientMessageId
     */
    async fallbackSendRest(content, clientMessageId) {
      try {
        const res = await window.apiClient.post(`/chat/groups/${this.groupId}/messages/text`, {
          content,
          clientMessageId
        });
        const savedMessage = res.data && res.data.message ? res.data.message : res.data;
        if (!this.socket || !this.isConnected) {
          this.appendMessage(savedMessage);
        }
      } catch (err) {
        if (window.Alerts) window.Alerts.error(err.message || 'Falha ao enviar mensagem.');
      }
    }

    /**
     * Notifica início e paragem de digitação
     */
    handleTyping() {
      if (!this.socket || !this.isConnected) return;

      if (!this.isTyping) {
        this.isTyping = true;
        this.socket.emit('chat:typing_start', { groupId: this.groupId });
      }

      if (this.typingTimeout) clearTimeout(this.typingTimeout);

      this.typingTimeout = setTimeout(() => {
        this.stopTyping();
      }, 2500);
    }

    stopTyping() {
      if (this.isTyping && this.socket && this.isConnected) {
        this.isTyping = false;
        this.socket.emit('chat:typing_stop', { groupId: this.groupId });
      }
      if (this.typingTimeout) clearTimeout(this.typingTimeout);
    }

    showTypingIndicator() {
      if (this.typingIndicator) {
        this.typingIndicator.classList.remove('d-none');
      }
    }

    hideTypingIndicator() {
      if (this.typingIndicator) {
        this.typingIndicator.classList.add('d-none');
      }
    }

    /**
     * Renderiza e anexa uma mensagem à lista cronológica
     * @param {object} message
     * @param {boolean} [autoScroll=true]
     */
    appendMessage(message, autoScroll = true) {
      if (!this.messagesList) return;

      const emptyState = this.messagesList.querySelector('#chat-empty-state');
      if (emptyState) emptyState.remove();

      // Previne duplicação visual no cliente
      const existing = this.messagesList.querySelector(`[data-message-element-id="${message.id || message.messageId}"]`);
      if (existing) return;

      const el = this.buildMessageElement(message);
      this.messagesList.appendChild(el);

      if (autoScroll) {
        this.scrollToBottom(true);
      }
    }

    /**
     * Constrói o elemento HTML da mensagem
     * @param {object} message
     * @returns {HTMLElement}
     */
    buildMessageElement(message) {
      const msgId = message.id || message.messageId;
      const senderId = message.sender_id || message.senderId;
      const isMine = senderId === this.currentUserId;
      const isSystem = message.message_type === 'SYSTEM_EVENT';
      const isDeleted = Boolean(message.is_deleted);
      const isPinned = Boolean(message.is_pinned);
      const timeStr = this.formatTime(message.created_at || message.createdAt);
      const senderName = message.sender_name || message.senderName || 'Participante';

      const li = document.createElement('div');
      li.className = `d-flex mb-3 ${isSystem ? 'justify-content-center' : isMine ? 'justify-content-end' : 'justify-content-start'}`;
      li.setAttribute('data-message-element-id', msgId);

      if (isSystem) {
        li.innerHTML = `
          <div class="badge bg-light text-muted border px-3 py-2 text-wrap" style="max-width: 80%;">
            <i class="bi bi-info-circle me-1"></i> ${this.escapeHtml(message.content)}
          </div>
        `;
        return li;
      }

      let contentBody = '';

      if (isDeleted) {
        contentBody = `<em class="text-muted small"><i class="bi bi-slash-circle me-1"></i> Mensagem eliminada.</em>`;
      } else if (message.message_type === 'AUDIO') {
        const attachment = (message.attachments && message.attachments[0]) || {};
        const audioSrc = attachment.id ? `/api/v1/chat/attachments/${attachment.id}/download` : '';
        contentBody = `
          <div class="chat-audio-wrapper">
            <audio controls preload="none" class="w-100 mt-1" style="max-width: 260px;">
              <source src="${audioSrc}" type="${attachment.mimeType || 'audio/webm'}">
              O seu navegador não suporta a reprodução deste áudio.
            </audio>
          </div>
        `;
      } else if (message.message_type === 'DOCUMENT') {
        const attachment = (message.attachments && message.attachments[0]) || {};
        const docHref = attachment.id ? `/api/v1/chat/attachments/${attachment.id}/download` : '#';
        const docName = this.escapeHtml(attachment.originalFilename || 'Documento');
        const docSize = attachment.fileSizeBytes ? `(${(attachment.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB)` : '';

        contentBody = `
          <div class="chat-document-wrapper border rounded p-2 bg-white bg-opacity-75 my-1">
            <div class="d-flex align-items-center">
              <i class="bi bi-file-earmark-pdf fs-3 text-danger me-2"></i>
              <div class="text-truncate">
                <a href="${docHref}" target="_blank" class="fw-bold text-decoration-none text-dark small d-block text-truncate" style="max-width: 200px;">
                  ${docName}
                </a>
                <span class="text-muted" style="font-size: 0.75rem;">${docSize}</span>
              </div>
            </div>
            ${message.content ? `<p class="mb-0 mt-2 small text-dark">${this.escapeHtml(message.content)}</p>` : ''}
          </div>
        `;
      } else {
        contentBody = `<div class="chat-text-content">${this.escapeHtml(message.content)}</div>`;
      }

      const canDelete = isMine || this.isLeaderOrAdmin;

      li.innerHTML = `
        <div class="chat-bubble ${isMine ? 'chat-bubble-mine' : 'chat-bubble-other'} position-relative shadow-sm p-3 rounded-4" style="max-width: 75%; min-width: 140px;">
          ${!isMine ? `<div class="fw-bold small text-primary mb-1">${this.escapeHtml(senderName)}</div>` : ''}
          ${isPinned ? `<span class="badge bg-warning text-dark position-absolute top-0 end-0 m-2" style="font-size: 0.65rem;"><i class="bi bi-pin-fill"></i> Fixado</span>` : ''}
          
          ${contentBody}

          <div class="d-flex align-items-center justify-content-end mt-1 text-muted" style="font-size: 0.7rem;">
            <span class="me-1">${timeStr}</span>
            ${isMine ? '<i class="bi bi-check2 text-primary"></i>' : ''}
          </div>

          ${!isDeleted ? `
            <div class="chat-message-actions position-absolute top-0 end-0 p-1 d-none">
              <div class="dropdown">
                <button class="btn btn-sm btn-light border-0 p-1" data-bs-toggle="dropdown" aria-expanded="false">
                  <i class="bi bi-three-dots-vertical"></i>
                </button>
                <ul class="dropdown-menu dropdown-menu-end shadow-sm">
                  ${this.isLeaderOrAdmin ? `
                    <li>
                      <button class="dropdown-item small" data-chat-action="pin" data-message-id="${msgId}" data-pinned="${isPinned}">
                        <i class="bi bi-pin me-2"></i> ${isPinned ? 'Desafixar' : 'Fixar Aviso'}
                      </button>
                    </li>
                  ` : ''}
                  ${!isMine ? `
                    <li>
                      <button class="dropdown-item small text-warning" data-chat-action="report" data-message-id="${msgId}">
                        <i class="bi bi-flag me-2"></i> Denunciar
                      </button>
                    </li>
                  ` : ''}
                  ${canDelete ? `
                    <li><hr class="dropdown-divider"></li>
                    <li>
                      <button class="dropdown-item small text-danger" data-chat-action="delete" data-message-id="${msgId}">
                        <i class="bi bi-trash me-2"></i> Eliminar
                      </button>
                    </li>
                  ` : ''}
                </ul>
              </div>
            </div>
          ` : ''}
        </div>
      `;

      // Mostra as ações ao passar o cursor por cima da bolha
      li.addEventListener('mouseenter', () => {
        const actions = li.querySelector('.chat-message-actions');
        if (actions) actions.classList.remove('d-none');
      });

      li.addEventListener('mouseleave', () => {
        const actions = li.querySelector('.chat-message-actions');
        if (actions) actions.classList.add('d-none');
      });

      return li;
    }

    /**
     * Atualiza a interface gráfica quando uma mensagem é eliminada logicamente
     * @param {string} messageId
     */
    handleMessageDeletedUI(messageId) {
      const el = this.messagesList?.querySelector(`[data-message-element-id="${messageId}"]`);
      if (el) {
        const contentBox = el.querySelector('.chat-text-content, .chat-audio-wrapper, .chat-document-wrapper');
        if (contentBox) {
          contentBox.outerHTML = `<em class="text-muted small"><i class="bi bi-slash-circle me-1"></i> Mensagem eliminada.</em>`;
        }
        const actions = el.querySelector('.chat-message-actions');
        if (actions) actions.remove();
      }
    }

    /**
     * Executa a eliminação lógica de uma mensagem (Soft Delete)
     * @param {string} messageId
     */
    async deleteMessage(messageId) {
      if (window.Alerts) {
        const confirm = await window.Alerts.confirm({
          title: 'Eliminar Mensagem?',
          text: 'Esta mensagem será removida do histórico da conversa para todos os membros.',
          confirmButtonText: 'Sim, eliminar',
          isDangerous: true
        });
        if (!confirm) return;
      }

      try {
        await window.apiClient.delete(`/chat/messages/${messageId}`);
        this.handleMessageDeletedUI(messageId);
        if (window.Alerts) window.Alerts.toast('Mensagem eliminada.', 'info');
      } catch (err) {
        if (window.Alerts) window.Alerts.error(err.message || 'Falha ao eliminar mensagem.');
      }
    }

    /**
     * Fixa ou desafixa um aviso no topo da sala
     * @param {string} messageId
     * @param {boolean} isPinned
     */
    async togglePinMessage(messageId, isPinned) {
      try {
        await window.apiClient.patch(`/chat/messages/${messageId}/pin`, { isPinned });
        this.loadPinnedMessages();
        if (window.Alerts) window.Alerts.toast(isPinned ? 'Aviso fixado no topo.' : 'Aviso desafixado.', 'success');
      } catch (err) {
        if (window.Alerts) window.Alerts.error(err.message || 'Erro ao fixar aviso.');
      }
    }

    /**
     * Submete uma denúncia comunitária contra mensagem abusiva
     * @param {string} messageId
     */
    async reportMessage(messageId) {
      let reason = '';
      if (window.Alerts && typeof window.Alerts.prompt === 'function') {
        reason = await window.Alerts.prompt({
          title: 'Denunciar Mensagem',
          text: 'Descreva a infração às regras da Kixikila:',
          inputPlaceholder: 'Conteúdo ofensivo, fraude, cobrança indevida...'
        });
      }

      if (!reason || reason.trim().length < 5) {
        if (window.Alerts) window.Alerts.warning('A denúncia exige uma justificativa com pelo menos 5 caracteres.');
        return;
      }

      try {
        await window.apiClient.post(`/chat/groups/${this.groupId}/messages/${messageId}/report`, {
          reason: reason.trim()
        });
        if (window.Alerts) {
          await window.Alerts.success('Denúncia Submetida', 'A liderança do grupo e a moderação foram notificadas.');
        }
      } catch (err) {
        if (window.Alerts) window.Alerts.error(err.message || 'Erro ao submeter denúncia.');
      }
    }

    /**
     * Confirma a leitura de uma mensagem no backend
     * @param {string} messageId
     */
    async markMessageAsRead(messageId) {
      if (!messageId) return;
      try {
        await window.apiClient.post(`/chat/messages/${messageId}/read`, { groupId: this.groupId });
      } catch (e) {}
    }

    /**
     * Rola o ecrã para o fundo da lista de mensagens
     * @param {boolean} [smooth=true]
     */
    scrollToBottom(smooth = true) {
      if (!this.messagesList) return;
      this.messagesList.scrollTo({
        top: this.messagesList.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    }

    /**
     * Formata carimbo de hora (HH:mm)
     * @param {string|Date} dateInput
     * @returns {string}
     */
    formatTime(dateInput) {
      if (!dateInput) return '';
      const d = new Date(dateInput);
      if (isNaN(d.getTime())) return '';
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }

    /**
     * Escapa caracteres HTML para prevenir injeção XSS
     * @param {string} str
     * @returns {string}
     */
    escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    /**
     * Apresenta estado visual de conversa vazia
     */
    renderEmptyState() {
      if (!this.messagesList) return;
      this.messagesList.innerHTML = `
        <div id="chat-empty-state" class="text-center p-5 text-muted my-auto">
          <i class="bi bi-chat-dots fs-1 text-primary opacity-50 mb-2"></i>
          <h6 class="fw-bold">Nenhuma mensagem neste grupo</h6>
          <p class="small text-muted mb-0">Inicie a conversa, partilhe documentos ou envie notas de voz.</p>
        </div>
      `;
    }
  }

  // Instanciação e exportação global
  window.ChatManager = ChatManager;
  window.chatManager = new ChatManager();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.querySelector('#chat-container')) {
        window.chatManager.init();
      }
    });
  } else if (document.querySelector('#chat-container')) {
    window.chatManager.init();
  }
})(typeof window !== 'undefined' ? window : this, document);