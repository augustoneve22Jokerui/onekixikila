/**
 * ONEKIXIKILA — GESTOR DE NOTIFICAÇÕES MULTICANAL (Vanilla JS / Browser)
 * Controla a consulta paginada de alertas, contagem de itens não lidos,
 * confirmação de leitura individual e em lote, filtragem por categoria,
 * recepção de eventos em tempo real via WebSockets e atualização do badge da navbar.
 */

(function (window, document) {
  'use strict';

  // Mapa de ícones e cores temáticas por tipo de evento de notificação
  const EVENT_ICON_MAP = Object.freeze({
    ACCOUNT_VERIFICATION: { icon: 'bi-shield-check', color: 'text-success', bg: 'bg-success-subtle' },
    PASSWORD_RESET: { icon: 'bi-key-fill', color: 'text-warning', bg: 'bg-warning-subtle' },
    LOGIN_ALERT: { icon: 'bi-box-arrow-in-right', color: 'text-info', bg: 'bg-info-subtle' },
    IDENTITY_REVIEW_RESULT: { icon: 'bi-person-badge', color: 'text-primary', bg: 'bg-primary-subtle' },
    CONTRIBUTION_DUE_ALERT: { icon: 'bi-alarm-fill', color: 'text-danger', bg: 'bg-danger-subtle' },
    PAYMENT_CONFIRMED: { icon: 'bi-check-circle-fill', color: 'text-success', bg: 'bg-success-subtle' },
    PAYMENT_FAILED: { icon: 'bi-x-circle-fill', color: 'text-danger', bg: 'bg-danger-subtle' },
    GROUP_INVITATION: { icon: 'bi-envelope-paper-fill', color: 'text-primary', bg: 'bg-primary-subtle' },
    ROTATION_BENEFICIARY_TURN: { icon: 'bi-cash-coin', color: 'text-success', bg: 'bg-success-subtle' },
    CHAT_MESSAGE: { icon: 'bi-chat-dots-fill', color: 'text-info', bg: 'bg-info-subtle' },
    DEFAULT: { icon: 'bi-bell-fill', color: 'text-secondary', bg: 'bg-light' }
  });

  class NotificationsManager {
    constructor() {
      this.unreadCount = 0;
      this.currentPage = 1;
      this.pageSize = 20;
      this.totalItems = 0;
      this.totalPages = 1;
      this.activeFilter = 'all'; // 'all', 'unread', 'read'

      // Elementos do DOM
      this.badgeElements = [];
      this.listContainer = null;
      this.paginationContainer = null;
      this.markAllReadBtn = null;
      this.filterButtons = [];
    }

    /**
     * Inicializa a escuta de eventos e sincronização de notificações
     */
    init() {
      this.bindDOMElements();
      this.bindEvents();
      this.fetchUnreadCount();

      // Se a página atual contiver a lista detalhada de notificações
      if (this.listContainer) {
        this.loadNotifications(1);
      }

      this.listenToRealTimeNotifications();
    }

    /**
     * Localiza os elementos da interface no DOM
     */
    bindDOMElements() {
      this.badgeElements = document.querySelectorAll('#notification-badge, .unread-notifications-count');
      this.listContainer = document.querySelector('#notifications-list-container');
      this.paginationContainer = document.querySelector('#notifications-pagination');
      this.markAllReadBtn = document.querySelector('#mark-all-notifications-read-btn');
      this.filterButtons = document.querySelectorAll('[data-notification-filter]');
    }

    /**
     * Regista ouvintes de eventos para filtros e ações em lote
     */
    bindEvents() {
      if (this.markAllReadBtn) {
        this.markAllReadBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.markAllAsRead();
        });
      }

      this.filterButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.filterButtons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');

          this.activeFilter = btn.getAttribute('data-notification-filter') || 'all';
          this.loadNotifications(1);
        });
      });

      // Delegação de cliques para leitura de itens individuais na lista
      if (this.listContainer) {
        this.listContainer.addEventListener('click', (e) => {
          const itemEl = e.target.closest('[data-notification-id]');
          if (!itemEl) return;

          const notifId = itemEl.getAttribute('data-notification-id');
          const isRead = itemEl.getAttribute('data-is-read') === 'true';

          if (!isRead && notifId) {
            this.markAsRead(notifId, itemEl);
          }

          // Se a notificação contiver URL de ação vinculada no payload
          const actionUrl = itemEl.getAttribute('data-action-url');
          if (actionUrl && !e.target.closest('button')) {
            window.location.href = actionUrl;
          }
        });
      }
    }

    /**
     * Consulta a contagem total de notificações não lidas para o badge
     */
    async fetchUnreadCount() {
      try {
        if (!window.apiClient) return;
        const res = await window.apiClient.get('/notifications/unread-count');
        const count = res && res.data && res.data.unreadCount !== undefined ? res.data.unreadCount : 0;
        this.updateBadge(count);
      } catch (err) {
        // Falha silenciosa em conexões temporárias
      }
    }

    /**
     * Atualiza o badge da barra de navegação com a contagem atualizada
     * @param {number} count
     */
    updateBadge(count) {
      this.unreadCount = Math.max(0, Number(count) || 0);

      this.badgeElements.forEach((badge) => {
        if (this.unreadCount > 0) {
          badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
          badge.classList.remove('d-none');
        } else {
          badge.classList.add('d-none');
        }
      });
    }

    /**
     * Carrega a lista paginada de notificações a partir do backend
     * @param {number} [page=1]
     */
    async loadNotifications(page = 1) {
      if (!this.listContainer || !window.apiClient) return;

      this.currentPage = page;
      this.listContainer.innerHTML = `
        <div class="text-center p-5 text-muted">
          <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
          <p class="small mb-0">A carregar notificações...</p>
        </div>
      `;

      const params = new URLSearchParams({
        page: String(this.currentPage),
        limit: String(this.pageSize)
      });

      if (this.activeFilter === 'unread') {
        params.set('isRead', 'false');
      } else if (this.activeFilter === 'read') {
        params.set('isRead', 'true');
      }

      try {
        const res = await window.apiClient.get(`/notifications?${params.toString()}`);
        const items = res.data || [];
        const pagination = res.pagination || {};

        this.totalItems = pagination.totalItems || items.length;
        this.totalPages = pagination.totalPages || 1;

        if (items.length === 0) {
          this.renderEmptyState();
          this.renderPagination();
          return;
        }

        this.listContainer.innerHTML = '';
        items.forEach((notif) => {
          this.listContainer.appendChild(this.buildNotificationElement(notif));
        });

        this.renderPagination();
      } catch (err) {
        this.listContainer.innerHTML = `
          <div class="alert alert-warning text-center p-4 m-3">
            <i class="bi bi-exclamation-triangle fs-3 text-warning"></i>
            <p class="small mt-2 mb-0">Não foi possível carregar as suas notificações.</p>
          </div>
        `;
      }
    }

    /**
     * Constrói o elemento HTML de uma notificação individual
     * @param {object} notif
     * @returns {HTMLElement}
     */
    buildNotificationElement(notif) {
      const typeConfig = EVENT_ICON_MAP[notif.event_type] || EVENT_ICON_MAP.DEFAULT;
      const isRead = Boolean(notif.is_read);
      const relativeTime = window.App ? window.App.formatRelativeTime(notif.created_at) : '';
      const payload = notif.payload || {};
      const actionUrl = payload.actionUrl || payload.url || '';

      const div = document.createElement('div');
      div.className = `list-group-item list-group-item-action p-3 border-start-4 transition-all ${
        isRead ? 'bg-white opacity-75' : 'bg-light border-primary'
      }`;
      div.setAttribute('data-notification-id', notif.id);
      div.setAttribute('data-is-read', String(isRead));
      if (actionUrl) div.setAttribute('data-action-url', actionUrl);
      div.style.cursor = 'pointer';

      div.innerHTML = `
        <div class="d-flex align-items-start">
          <div class="rounded-circle p-2 me-3 ${typeConfig.bg} ${typeConfig.color} d-flex align-items-center justify-content-center" style="width: 42px; height: 42px;">
            <i class="bi ${typeConfig.icon} fs-5"></i>
          </div>
          <div class="flex-grow-1 overflow-hidden">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <h6 class="mb-0 fw-bold small text-dark ${isRead ? '' : 'text-primary'}">${this.escapeHtml(notif.title)}</h6>
              <span class="text-muted small" style="font-size: 0.75rem;">${relativeTime}</span>
            </div>
            <p class="mb-1 text-muted small text-break">${this.escapeHtml(notif.message)}</p>
            <div class="d-flex align-items-center justify-content-between mt-2">
              <span class="badge ${isRead ? 'bg-secondary' : 'bg-primary'} bg-opacity-10 text-${isRead ? 'secondary' : 'primary'}" style="font-size: 0.7rem;">
                ${this.formatEventLabel(notif.event_type)}
              </span>
              ${
                !isRead
                  ? `
                <button class="btn btn-sm btn-link p-0 text-decoration-none text-muted small" title="Marcar como lida">
                  <i class="bi bi-check2-all text-primary me-1"></i> Marcar como lida
                </button>
              `
                  : ''
              }
            </div>
          </div>
        </div>
      `;

      return div;
    }

    /**
     * Marca uma notificação individual como lida
     * @param {string} notificationId
     * @param {HTMLElement} [element]
     */
    async markAsRead(notificationId, element = null) {
      try {
        await window.apiClient.patch(`/notifications/${notificationId}/read`, {});

        if (element) {
          element.setAttribute('data-is-read', 'true');
          element.classList.remove('bg-light', 'border-primary');
          element.classList.add('bg-white', 'opacity-75');

          const checkBtn = element.querySelector('button');
          if (checkBtn) checkBtn.remove();
        }

        this.updateBadge(this.unreadCount - 1);
      } catch (err) {
        // Falha silenciosa na leitura individual
      }
    }

    /**
     * Marca todas as notificações do utilizador como lidas em lote
     */
    async markAllAsRead() {
      try {
        if (window.Alerts) window.Alerts.showLoading('A atualizar...', 'Marcando notificações como lidas.');

        const res = await window.apiClient.patch('/notifications/read-all', {});

        if (window.Alerts) {
          window.Alerts.closeLoading();
          window.Alerts.toast(res.message || 'Todas as notificações foram marcadas como lidas.', 'success');
        }

        this.updateBadge(0);

        if (this.listContainer) {
          this.loadNotifications(this.currentPage);
        }
      } catch (err) {
        if (window.Alerts) {
          window.Alerts.closeLoading();
          window.Alerts.error(err.message || 'Erro ao marcar notificações.');
        }
      }
    }

    /**
     * Conecta ouvinte no Socket.IO para alertas instantâneos enquanto o utilizador navega
     */
    listenToRealTimeNotifications() {
      if (typeof window.io === 'undefined') return;

      const checkSocket = () => {
        if (window.chatManager && window.chatManager.socket) {
          window.chatManager.socket.on('notification:new', (notif) => {
            this.handleIncomingRealTimeNotification(notif);
          });
        }
      };

      // Tenta anexar ouvinte após inicialização dos websockets
      setTimeout(checkSocket, 1500);
    }

    /**
     * Apresenta toast flutuante e incrementa o badge ao receber notificação em tempo real
     * @param {object} notif
     */
    handleIncomingRealTimeNotification(notif) {
      if (!notif) return;

      this.updateBadge(this.unreadCount + 1);

      if (window.Alerts && typeof window.Alerts.toast === 'function') {
        const title = notif.title || 'Nova Notificação';
        const msg = notif.message ? `: ${notif.message}` : '';
        window.Alerts.toast(`${title}${msg}`, 'info', 4500);
      }

      // Se o utilizador estiver na página de notificações e na aba 'all' ou 'unread', insere no topo
      if (this.listContainer && (this.activeFilter === 'all' || this.activeFilter === 'unread')) {
        const emptyState = this.listContainer.querySelector('#notifications-empty-state');
        if (emptyState) emptyState.remove();

        const el = this.buildNotificationElement(notif);
        this.listContainer.insertBefore(el, this.listContainer.firstChild);
      }
    }

    /**
     * Renderiza os controles de paginação
     */
    renderPagination() {
      if (!this.paginationContainer) return;

      if (this.totalPages <= 1) {
        this.paginationContainer.innerHTML = '';
        return;
      }

      let html = '<ul class="pagination pagination-sm justify-content-center mb-0">';

      // Botão Anterior
      html += `
        <li class="page-item ${this.currentPage === 1 ? 'disabled' : ''}">
          <button class="page-link" data-page="${this.currentPage - 1}">Anterior</button>
        </li>
      `;

      for (let p = 1; p <= this.totalPages; p++) {
        if (p === 1 || p === this.totalPages || (p >= this.currentPage - 1 && p <= this.currentPage + 1)) {
          html += `
            <li class="page-item ${p === this.currentPage ? 'active' : ''}">
              <button class="page-link" data-page="${p}">${p}</button>
            </li>
          `;
        } else if (p === this.currentPage - 2 || p === this.currentPage + 2) {
          html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
        }
      }

      // Botão Seguinte
      html += `
        <li class="page-item ${this.currentPage === this.totalPages ? 'disabled' : ''}">
          <button class="page-link" data-page="${this.currentPage + 1}">Seguinte</button>
        </li>
      `;
      html += '</ul>';

      this.paginationContainer.innerHTML = html;

      this.paginationContainer.querySelectorAll('[data-page]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const targetPage = Number(btn.getAttribute('data-page'));
          if (targetPage > 0 && targetPage <= this.totalPages) {
            this.loadNotifications(targetPage);
          }
        });
      });
    }

    /**
     * Apresenta estado visual de caixa de notificações vazia
     */
    renderEmptyState() {
      if (!this.listContainer) return;
      this.listContainer.innerHTML = `
        <div id="notifications-empty-state" class="text-center p-5 text-muted">
          <i class="bi bi-bell-slash fs-1 text-secondary opacity-50 mb-2"></i>
          <h6 class="fw-bold">Nenhuma notificação encontrada</h6>
          <p class="small text-muted mb-0">Quando existirem novidades sobre as suas quotas ou grupos, elas surgirão aqui.</p>
        </div>
      `;
    }

    /**
     * Traduz o código de evento para texto legível
     * @param {string} eventType
     * @returns {string}
     */
    formatEventLabel(eventType) {
      const labels = {
        CONTRIBUTION_DUE_ALERT: 'Vencimento de Quota',
        ROTATION_BENEFICIARY_TURN: 'Recebimento de Bolo',
        PAYMENT_CONFIRMED: 'Pagamento Confirmado',
        PAYMENT_FAILED: 'Falha de Pagamento',
        GROUP_INVITATION: 'Convite para Grupo',
        IDENTITY_REVIEW_RESULT: 'Verificação KYC',
        LOGIN_ALERT: 'Segurança de Acesso'
      };
      return labels[eventType] || 'Alerta';
    }

    /**
     * Escapa caracteres especiais para prevenir injeção HTML
     * @param {string} str
     * @returns {string}
     */
    escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  }

  // Instanciação e exportação global
  window.NotificationsManager = NotificationsManager;
  window.notificationsManager = new NotificationsManager();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.notificationsManager.init();
    });
  } else {
    window.notificationsManager.init();
  }
})(typeof window !== 'undefined' ? window : this, document);