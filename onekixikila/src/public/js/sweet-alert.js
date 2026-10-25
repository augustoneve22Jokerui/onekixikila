/**
 * ONEKIXIKILA — ADAPTADOR DE ALERTAS E MODAIS (SweetAlert2 Wrapper)
 * Padroniza diálogos de confirmação, modais informativos, toasts não intrusivos
 * e indicadores de carregamento com as cores e identidade visual da OneKixikila.
 * Providencia contingência graciosa para diálogos nativos caso a CDN do SweetAlert2 esteja offline.
 */

(function (window) {
  'use strict';

  // Configuração de cores institucionais da OneKixikila
  const THEME_COLORS = {
    primary: '#0d6efd',
    success: '#198754',
    danger: '#dc3545',
    warning: '#ffc107',
    info: '#0dcaf0',
    dark: '#212529',
    cancel: '#6c757d'
  };

  class AlertsManager {
    constructor() {
      this.isSwalAvailable = typeof window.Swal !== 'undefined';
      this.initToastMixin();
    }

    /**
     * Atualiza a verificação de disponibilidade do SweetAlert2 caso carregado assincronamente
     */
    checkSwal() {
      if (!this.isSwalAvailable && typeof window.Swal !== 'undefined') {
        this.isSwalAvailable = true;
        this.initToastMixin();
      }
      return this.isSwalAvailable;
    }

    /**
     * Configura o mixin de Toast flutuante rápido
     */
    initToastMixin() {
      if (typeof window.Swal !== 'undefined') {
        this.Toast = window.Swal.mixin({
          toast: true,
          position: 'top-end',
          showConfirmButton: false,
          timer: 3500,
          timerProgressBar: true,
          didOpen: (toast) => {
            toast.addEventListener('mouseenter', window.Swal.stopTimer);
            toast.addEventListener('mouseleave', window.Swal.resumeTimer);
          }
        });
      }
    }

    /**
     * Exibe um alerta de sucesso
     * @param {string} titleOrMessage
     * @param {string} [text]
     * @returns {Promise<any>}
     */
    async success(titleOrMessage, text = '') {
      if (this.checkSwal()) {
        return window.Swal.fire({
          icon: 'success',
          title: text ? titleOrMessage : 'Sucesso',
          text: text || titleOrMessage,
          confirmButtonColor: THEME_COLORS.success,
          confirmButtonText: 'Entendido'
        });
      }
      window.alert(`✓ ${text ? titleOrMessage + ': ' + text : titleOrMessage}`);
      return Promise.resolve();
    }

    /**
     * Exibe um alerta de erro
     * @param {string} titleOrMessage
     * @param {string} [text]
     * @returns {Promise<any>}
     */
    async error(titleOrMessage, text = '') {
      if (this.checkSwal()) {
        return window.Swal.fire({
          icon: 'error',
          title: text ? titleOrMessage : 'Erro',
          text: text || titleOrMessage,
          confirmButtonColor: THEME_COLORS.danger,
          confirmButtonText: 'Fechar'
        });
      }
      window.alert(`✕ ${text ? titleOrMessage + ': ' + text : titleOrMessage}`);
      return Promise.resolve();
    }

    /**
     * Exibe um alerta de aviso/atenção
     * @param {string} titleOrMessage
     * @param {string} [text]
     * @returns {Promise<any>}
     */
    async warning(titleOrMessage, text = '') {
      if (this.checkSwal()) {
        return window.Swal.fire({
          icon: 'warning',
          title: text ? titleOrMessage : 'Atenção',
          text: text || titleOrMessage,
          confirmButtonColor: THEME_COLORS.warning,
          confirmButtonText: 'Entendido'
        });
      }
      window.alert(`⚠ ${text ? titleOrMessage + ': ' + text : titleOrMessage}`);
      return Promise.resolve();
    }

    /**
     * Exibe um alerta puramente informativo
     * @param {string} titleOrMessage
     * @param {string} [text]
     * @returns {Promise<any>}
     */
    async info(titleOrMessage, text = '') {
      if (this.checkSwal()) {
        return window.Swal.fire({
          icon: 'info',
          title: text ? titleOrMessage : 'Informação',
          text: text || titleOrMessage,
          confirmButtonColor: THEME_COLORS.primary,
          confirmButtonText: 'OK'
        });
      }
      window.alert(`ℹ ${text ? titleOrMessage + ': ' + text : titleOrMessage}`);
      return Promise.resolve();
    }

    /**
     * Exibe um modal de confirmação com promessa booleana (resolvida como true se confirmado)
     * @param {object} options
     * @param {string} [options.title='Confirmar Ação?']
     * @param {string} [options.text='Esta ação não poderá ser revertida.']
     * @param {string} [options.confirmButtonText='Sim, confirmar']
     * @param {string} [options.cancelButtonText='Cancelar']
     * @param {string} [options.icon='warning']
     * @param {boolean} [options.isDangerous=false]
     * @returns {Promise<boolean>}
     */
    async confirm(options = {}) {
      const {
        title = 'Confirmar Operação?',
        text = 'Tem a certeza que deseja prosseguir?',
        confirmButtonText = 'Sim, confirmar',
        cancelButtonText = 'Cancelar',
        icon = 'warning',
        isDangerous = false
      } = options;

      if (this.checkSwal()) {
        const result = await window.Swal.fire({
          title,
          text,
          icon,
          showCancelButton: true,
          confirmButtonColor: isDangerous ? THEME_COLORS.danger : THEME_COLORS.primary,
          cancelButtonColor: THEME_COLORS.cancel,
          confirmButtonText,
          cancelButtonText,
          reverseButtons: true,
          focusCancel: true
        });

        return Boolean(result.isConfirmed);
      }

      return Promise.resolve(window.confirm(`${title}\n\n${text}`));
    }

    /**
     * Exibe um diálogo de entrada de texto (prompt)
     * @param {object} options
     * @param {string} options.title
     * @param {string} [options.text]
     * @param {string} [options.inputPlaceholder]
     * @param {string} [options.confirmButtonText='Submeter']
     * @returns {Promise<string|null>}
     */
    async prompt(options = {}) {
      const {
        title = 'Insira a informação:',
        text = '',
        inputPlaceholder = 'Digite aqui...',
        confirmButtonText = 'Submeter'
      } = options;

      if (this.checkSwal()) {
        const result = await window.Swal.fire({
          title,
          text,
          input: 'text',
          inputPlaceholder,
          showCancelButton: true,
          confirmButtonColor: THEME_COLORS.primary,
          cancelButtonColor: THEME_COLORS.cancel,
          confirmButtonText,
          cancelButtonText: 'Cancelar',
          inputValidator: (value) => {
            if (!value || !value.trim()) {
              return 'O campo não pode estar vazio.';
            }
          }
        });

        return result.isConfirmed && result.value ? result.value.trim() : null;
      }

      const input = window.prompt(`${title}\n${text}`);
      return input !== null && input.trim() !== '' ? input.trim() : null;
    }

    /**
     * Exibe uma notificação flutuante não bloqueante (Toast)
     * @param {string} message
     * @param {'success'|'error'|'warning'|'info'} [icon='info']
     * @param {number} [timer=3500]
     */
    toast(message, icon = 'info', timer = 3500) {
      if (this.checkSwal() && this.Toast) {
        this.Toast.fire({
          icon,
          title: message,
          timer
        });
        return;
      }

      // Contingência sem SweetAlert: insere toast flutuante no DOM
      this.createFallbackToast(message, icon);
    }

    /**
     * Exibe indicador de carregamento bloqueante enquanto uma operação financeira é processada
     * @param {string} [title='A processar operação...']
     * @param {string} [text='Por favor, aguarde a confirmação da rede.']
     */
    showLoading(title = 'A processar...', text = 'Por favor, aguarde...') {
      if (this.checkSwal()) {
        window.Swal.fire({
          title,
          text,
          allowOutsideClick: false,
          allowEscapeKey: false,
          showConfirmButton: false,
          didOpen: () => {
            window.Swal.showLoading();
          }
        });
      }
    }

    /**
     * Fecha o indicador de carregamento aberto
     */
    closeLoading() {
      if (this.checkSwal() && window.Swal.isVisible()) {
        window.Swal.close();
      }
    }

    /**
     * Fallback leve de toast para quando a biblioteca SweetAlert2 não estiver presente
     * @param {string} message
     * @param {string} icon
     * @private
     */
    createFallbackToast(message, icon) {
      const toastEl = document.createElement('div');
      toastEl.className = `alert alert-${icon === 'error' ? 'danger' : icon} position-fixed top-0 end-0 m-3 shadow-lg`;
      toastEl.style.zIndex = '99999';
      toastEl.style.minWidth = '250px';
      toastEl.textContent = message;

      document.body.appendChild(toastEl);
      setTimeout(() => {
        if (toastEl.parentNode) {
          toastEl.parentNode.removeChild(toastEl);
        }
      }, 3500);
    }
  }

  // Exportação global no navegador
  window.AlertsManager = AlertsManager;
  window.Alerts = new AlertsManager();
  window.SweetAlert = window.Alerts;
})(typeof window !== 'undefined' ? window : this);