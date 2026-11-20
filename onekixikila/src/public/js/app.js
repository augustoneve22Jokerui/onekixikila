/**
 * ONEKIXIKILA — APLICAÇÃO CLIENTE PRINCIPAL (Vanilla JS / Frontend Core)
 * Inicialização global da interface, formatação regional de Kwanzas (AOA) e datas,
 * polling de notificações não lidas, controlo de botões contra duplo clique,
 * destaque de navegação ativa e gestão de encerramento de sessão.
 */

(function (window, document) {
  'use strict';

  const App = {
    /**
     * Moeda e configurações padrão
     */
    config: {
      currencySymbol: 'Kz',
      currencyCode: 'AOA',
      locale: 'pt-AO',
      notificationPollingIntervalMs: 45000 // 45 segundos
    },

    /**
     * Inicialização disparada após o carregamento do DOM
     */
    init() {
      this.initBootstrapComponents();
      this.highlightActiveNavigation();
      this.initFormDoubleSubmitProtection();
      this.initLogoutHandlers();
      this.initUrlFlashMessages();
      this.initNotificationPolling();
      this.initClipboardHelpers();
    },

    /**
     * Formata um valor numérico em Kwanzas angolanos (AOA)
     * Exemplo: 50000 -> "50.000 Kz"
     *
     * @param {number|string|bigint} amount
     * @param {string} [currency='AOA']
     * @returns {string}
     */
    formatMoney(amount, currency = 'AOA') {
      const num = Number(amount) || 0;
      const formatted = num.toLocaleString(this.config.locale, {
        maximumFractionDigits: 0
      });
      return `${formatted} ${this.config.currencySymbol}`;
    },

    /**
     * Formata uma data para o padrão de Angola (DD/MM/AAAA HH:mm)
     *
     * @param {Date|string} dateInput
     * @param {boolean} [includeTime=true]
     * @returns {string}
     */
    formatDate(dateInput, includeTime = true) {
      if (!dateInput) return '—';
      const d = new Date(dateInput);
      if (isNaN(d.getTime())) return '—';

      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();

      if (!includeTime) {
        return `${day}/${month}/${year}`;
      }

      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${day}/${month}/${year} às ${hours}:${minutes}`;
    },

    /**
     * Retorna a representação de tempo relativo amigável (ex: "há 5 minutos", "ontem")
     *
     * @param {Date|string} dateInput
     * @returns {string}
     */
    formatRelativeTime(dateInput) {
      if (!dateInput) return '';
      const d = new Date(dateInput);
      const now = new Date();
      const diffMs = now - d;
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHours = Math.floor(diffMin / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSec < 60) return 'agora mesmo';
      if (diffMin < 60) return `há ${diffMin} min`;
      if (diffHours < 24) return `há ${diffHours} h`;
      if (diffDays === 1) return 'ontem';
      if (diffDays < 7) return `há ${diffDays} dias`;

      return this.formatDate(dateInput, false);
    },

    /**
     * Inicializa Tooltips e Popovers do Bootstrap 5 caso disponíveis na página
     */
    initBootstrapComponents() {
      if (typeof bootstrap !== 'undefined') {
        const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
        tooltipTriggerList.forEach(function (tooltipTriggerEl) {
          new bootstrap.Tooltip(tooltipTriggerEl);
        });

        const popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'));
        popoverTriggerList.forEach(function (popoverTriggerEl) {
          new bootstrap.Popover(popoverTriggerEl);
        });
      }
    },

    /**
     * Destaca visualmente o item ativo na barra de navegação e menu lateral
     */
    highlightActiveNavigation() {
      const currentPath = window.location.pathname;
      const navLinks = document.querySelectorAll('.nav-link, .sidebar-link');

      navLinks.forEach((link) => {
        const href = link.getAttribute('href');
        if (!href) return;

        if (href === currentPath || (href !== '/' && currentPath.startsWith(href))) {
          link.classList.add('active');
          const parentItem = link.closest('.nav-item');
          if (parentItem) {
            parentItem.classList.add('active');
          }
        }
      });
    },

    /**
     * Previne submissões duplicadas acidentais (double submit) desabilitando botões
     * e exibindo indicador de carregamento durante o envio de formulários
     */
    initFormDoubleSubmitProtection() {
      document.addEventListener('submit', function (e) {
        const form = e.target;
        if (!form || form.getAttribute('data-no-auto-disable') === 'true') {
          return;
        }

        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn && !submitBtn.disabled) {
          submitBtn.setAttribute('data-original-html', submitBtn.innerHTML);
          submitBtn.disabled = true;

          const loadingText = submitBtn.getAttribute('data-loading-text') || 'A processar...';
          submitBtn.innerHTML = `
            <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
            ${loadingText}
          `;

          // Reabilita preventivamente após 20 segundos em caso de timeout na rede
          setTimeout(() => {
            if (submitBtn.disabled) {
              submitBtn.disabled = false;
              submitBtn.innerHTML = submitBtn.getAttribute('data-original-html') || 'Confirmar';
            }
          }, 20000);
        }
      });
    },

    /**
     * Interceta botões de encerramento de sessão (Logout)
     */
    initLogoutHandlers() {
      const logoutElements = document.querySelectorAll('[data-action="logout"], #logout-btn');
      logoutElements.forEach((el) => {
        el.addEventListener('click', async (e) => {
          e.preventDefault();

          if (window.Alerts && typeof window.Alerts.confirm === 'function') {
            const confirmed = await window.Alerts.confirm({
              title: 'Terminar Sessão?',
              text: 'Deseja encerrar a sua sessão na plataforma OneKixikila?',
              confirmButtonText: 'Sim, sair'
            });
            if (!confirmed) return;
          }

          try {
            if (window.apiClient) {
              await window.apiClient.post('/auth/logout', {});
              window.apiClient.clearSession();
            }
          } catch (err) {
            // Continua o redirecionamento mesmo se o pedido de logout falhar na rede
          } finally {
            window.location.href = '/login';
          }
        });
      });
    },

    /**
     * Exibe notificações visuais (Toasts) a partir de parâmetros na URL (ex: ?success=..., ?expired=1)
     */
    initUrlFlashMessages() {
      const urlParams = new URLSearchParams(window.location.search);

      if (urlParams.get('expired') === '1') {
        if (window.Alerts) {
          window.Alerts.warning('A sua sessão expirou por inatividade. Efetue login novamente.');
        }
      }

      const successMsg = urlParams.get('success');
      if (successMsg && window.Alerts) {
        window.Alerts.success(decodeURIComponent(successMsg));
      }

      const errorMsg = urlParams.get('error');
      if (errorMsg && window.Alerts) {
        window.Alerts.error(decodeURIComponent(errorMsg));
      }
    },

    /**
     * Inicia a atualização periódica do contador de notificações não lidas
     */
    initNotificationPolling() {
      const badge = document.querySelector('#notification-badge, .unread-notifications-count');
      if (!badge || !window.apiClient) {
        return;
      }

      const updateCount = async () => {
        try {
          const res = await window.apiClient.get('/notifications/unread-count');
          const count = res && res.data && res.data.unreadCount !== undefined ? res.data.unreadCount : 0;

          if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.classList.remove('d-none');
          } else {
            badge.classList.add('d-none');
          }
        } catch (e) {
          // Falhas silenciosas de polling em caso de perda de conexão temporária
        }
      };

      // Executa imediatamente e agenda periodicamente
      updateCount();
      setInterval(updateCount, this.config.notificationPollingIntervalMs);
    },

    /**
     * Configura botões de cópia rápida para a área de transferência (IBAN, código de convite, etc.)
     */
    initClipboardHelpers() {
      document.addEventListener('click', function (e) {
        const copyBtn = e.target.closest('[data-copy-text]');
        if (!copyBtn) return;

        const textToCopy = copyBtn.getAttribute('data-copy-text');
        if (!textToCopy) return;

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textToCopy).then(() => {
            if (window.Alerts && typeof window.Alerts.toast === 'function') {
              window.Alerts.toast('Copiado para a área de transferência!', 'success');
            }
          });
        }
      });
    }
  };

  // Exportação global e execução automática
  window.App = App;
  window.OneKixikila = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }
})(typeof window !== 'undefined' ? window : this, document);