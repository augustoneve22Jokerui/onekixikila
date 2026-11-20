/**
 * OneKixikila — SweetAlert2 Wrapper + Interceptor Nativo
 * -----------------------------------------------------------------------------
 * - Garante que o SweetAlert2 está carregado (CDN dinâmico se necessário).
 * - Substitui window.confirm e window.alert por diálogos SweetAlert2 bonitos.
 * - Expõe window.Alerts com helpers para transferências, depósitos, etc.
 * - Tema coerente com o resto da plataforma (roxo + superfícies escuras).
 * - Nunca cai para o confirm()/alert() nativo do browser.
 * -----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Constantes
  // ---------------------------------------------------------------------------
  const SWAL_CDN = 'https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.all.min.js';
  const SWAL_CSS = 'https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.min.css';

  const state = {
    swalPromise: null,
    themeApplied: false,
    originalConfirm: window.confirm ? window.confirm.bind(window) : null,
    originalAlert: window.alert ? window.alert.bind(window) : null,
    intercepting: false
  };

  // ---------------------------------------------------------------------------
  // 2. Carregar SweetAlert2 dinamicamente (idempotente)
  // ---------------------------------------------------------------------------
  function loadSwal() {
    if (state.swalPromise) return state.swalPromise;

    state.swalPromise = new Promise((resolve) => {
      if (window.Swal) return resolve(window.Swal);

      // CSS
      if (!document.querySelector(`link[data-ok-swal-css="1"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = SWAL_CSS;
        link.setAttribute('data-ok-swal-css', '1');
        document.head.appendChild(link);
      }

      // Script
      const existing = document.querySelector(`script[data-ok-swal-js="1"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(window.Swal || null));
        existing.addEventListener('error', () => resolve(null));
        return;
      }

      const script = document.createElement('script');
      script.src = SWAL_CDN;
      script.async = true;
      script.setAttribute('data-ok-swal-js', '1');
      script.onload = () => resolve(window.Swal || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });

    return state.swalPromise;
  }

  // ---------------------------------------------------------------------------
  // 3. Tema OneKixikila
  // ---------------------------------------------------------------------------
  function applyTheme() {
    if (!window.Swal || state.themeApplied) return;
    state.themeApplied = true;

    const root = document.documentElement;
    const isLight = root.getAttribute('data-theme') === 'light';

    const bg       = isLight ? '#ffffff' : '#0a0a10';
    const elevated = isLight ? '#f4f5f9' : '#111118';
    const text     = isLight ? '#0f172a' : '#ffffff';
    const muted    = isLight ? '#64748b' : '#94a3b8';
    const border   = isLight ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.08)';
    const purple   = '#7c3aed';
    const purpleV  = '#8b5cf6';

    window.Swal.apply({
      background: bg,
      color: text,
      confirmButtonColor: purple,
      cancelButtonColor: muted
    });

    if (!document.getElementById('ok-swal-theme')) {
      const style = document.createElement('style');
      style.id = 'ok-swal-theme';
      style.textContent = `
        .swal2-popup {
          border-radius: 20px !important;
          border: 1px solid ${border} !important;
          box-shadow: 0 20px 60px rgba(0,0,0,${isLight ? '0.15' : '0.55'}) !important;
          font-family: 'Plus Jakarta Sans', -apple-system, sans-serif !important;
          padding: 2rem 1.75rem !important;
          background: ${bg} !important;
          color: ${text} !important;
        }
        .swal2-title {
          font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif !important;
          font-weight: 800 !important;
          font-size: 1.35rem !important;
          letter-spacing: -0.02em !important;
          color: ${text} !important;
        }
        .swal2-html-container {
          color: ${muted} !important;
          font-size: 0.94rem !important;
          line-height: 1.55 !important;
          margin-top: 0.5rem !important;
        }
        .swal2-confirm, .swal2-cancel, .swal2-deny, .swal2-styled {
          border-radius: 9999px !important;
          font-weight: 800 !important;
          font-size: 0.88rem !important;
          padding: 0.65rem 1.6rem !important;
          letter-spacing: 0.01em !important;
          box-shadow: none !important;
        }
        .swal2-confirm {
          background: linear-gradient(135deg, ${purpleV} 0%, ${purple} 100%) !important;
          color: #ffffff !important;
        }
        .swal2-cancel {
          background: ${elevated} !important;
          color: ${text} !important;
          border: 1px solid ${border} !important;
        }
        .swal2-deny {
          background: rgba(244, 63, 94, 0.12) !important;
          color: #f43f5e !important;
          border: 1px solid rgba(244, 63, 94, 0.35) !important;
        }
        .swal2-actions { gap: 0.6rem !important; margin-top: 1.5rem !important; }
        .swal2-icon { margin: 0 auto 1rem auto !important; }
        .swal2-icon.swal2-success { border-color: #10b981 !important; color: #10b981 !important; }
        .swal2-icon.swal2-error   { border-color: #f43f5e !important; color: #f43f5e !important; }
        .swal2-icon.swal2-warning { border-color: #f59e0b !important; color: #f59e0b !important; }
        .swal2-icon.swal2-info    { border-color: #06b6d4 !important; color: #06b6d4 !important; }
        .swal2-icon.swal2-question { border-color: ${purpleV} !important; color: ${purpleV} !important; }
        .swal2-toast {
          border-radius: 14px !important;
          background: ${elevated} !important;
          border: 1px solid ${border} !important;
          color: ${text} !important;
          font-family: 'Plus Jakarta Sans', sans-serif !important;
        }
        .swal2-input, .swal2-textarea, .swal2-select {
          background: ${elevated} !important;
          color: ${text} !important;
          border: 1px solid ${border} !important;
          border-radius: 10px !important;
        }
        .swal2-validation-message {
          background: rgba(244, 63, 94, 0.12) !important;
          color: #f43f5e !important;
          border-radius: 10px !important;
        }
        .swal2-container.swal2-backdrop-show {
          background: rgba(5, 5, 8, 0.72) !important;
          backdrop-filter: blur(4px);
        }
      `;
      document.head.appendChild(style);
    }
  }

  // Reaplica tema se o data-theme mudar
  if (window.MutationObserver) {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme') {
          state.themeApplied = false;
          const css = document.getElementById('ok-swal-theme');
          if (css) css.remove();
          if (window.Swal) applyTheme();
          break;
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });
  }

  // ---------------------------------------------------------------------------
  // 4. Helpers de formatação
  // ---------------------------------------------------------------------------
  function formatKz(value) {
    const n = Number(value) || 0;
    return n.toLocaleString('pt-AO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Kz';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // 5. Fallback HTML próprio (se o CDN do Swal falhar)
  // ---------------------------------------------------------------------------
  function nativeFallbackPopup({ icon, title, text, confirmText, cancelText, isConfirm }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(5,5,8,0.75); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
        animation: okFadeIn 0.2s ease;
      `;

      const colors = {
        success: '#10b981', error: '#f43f5e', warning: '#f59e0b',
        info: '#06b6d4', question: '#8b5cf6'
      };
      const color = colors[icon] || colors.info;

      const icons = {
        success: '✓', error: '✕', warning: '!', info: 'i', question: '?'
      };

      const box = document.createElement('div');
      box.style.cssText = `
        background: #0a0a10; color: #ffffff;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 20px; padding: 2rem 1.75rem;
        max-width: 440px; width: calc(100% - 32px);
        box-shadow: 0 20px 60px rgba(0,0,0,0.6);
        text-align: center;
      `;

      const iconEl = document.createElement('div');
      iconEl.textContent = icons[icon] || 'i';
      iconEl.style.cssText = `
        width: 64px; height: 64px; margin: 0 auto 1rem auto;
        border-radius: 50%; display: flex; align-items: center;
        justify-content: center; font-size: 1.8rem; font-weight: 800;
        color: ${color}; border: 3px solid ${color};
      `;

      const titleEl = document.createElement('h3');
      titleEl.textContent = title || '';
      titleEl.style.cssText = `
        font-family: 'Space Grotesk', sans-serif; font-weight: 800;
        font-size: 1.3rem; margin: 0 0 0.5rem 0; letter-spacing: -0.02em;
      `;

      const textEl = document.createElement('p');
      textEl.textContent = text || '';
      textEl.style.cssText = `
        color: #94a3b8; font-size: 0.92rem; line-height: 1.5;
        margin: 0 0 1.5rem 0;
      `;

      const actions = document.createElement('div');
      actions.style.cssText = 'display: flex; gap: 0.6rem; justify-content: center;';

      function makeBtn(label, primary) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `
          border-radius: 9999px; font-weight: 800; font-size: 0.88rem;
          padding: 0.65rem 1.6rem; border: none; cursor: pointer;
          font-family: 'Plus Jakarta Sans', sans-serif;
          transition: transform 0.15s ease;
          ${primary
            ? `background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff;`
            : `background: #111118; color: #ffffff; border: 1px solid rgba(255,255,255,0.08);`}
        `;
        b.addEventListener('mouseenter', () => b.style.transform = 'translateY(-1px)');
        b.addEventListener('mouseleave', () => b.style.transform = '');
        return b;
      }

      function close(result) {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.2s ease';
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(result);
        }, 200);
      }

      if (isConfirm) {
        const cancelBtn = makeBtn(cancelText || 'Cancelar', false);
        cancelBtn.addEventListener('click', () => close(false));
        const okBtn = makeBtn(confirmText || 'Confirmar', true);
        okBtn.addEventListener('click', () => close(true));
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
      } else {
        const okBtn = makeBtn(confirmText || 'OK', true);
        okBtn.addEventListener('click', () => close(true));
        actions.appendChild(okBtn);
      }

      // Tecla ESC
      const onKey = (e) => {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(isConfirm ? false : true); }
        if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close(true); }
      };
      document.addEventListener('keydown', onKey);

      box.appendChild(iconEl);
      box.appendChild(titleEl);
      if (text) box.appendChild(textEl);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // Foco no botão principal
      setTimeout(() => {
        const btns = actions.querySelectorAll('button');
        if (btns.length) btns[btns.length - 1].focus();
      }, 50);
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Núcleo: garantir que o Swal está pronto, com fallback próprio
  // ---------------------------------------------------------------------------
  async function fireSafe(options) {
    const swal = await loadSwal();
    if (swal) {
      applyTheme();
      return swal.fire(options);
    }
    return nativeFallbackPopup({
      icon: options.icon || 'info',
      title: options.title,
      text: options.text || (options.html ? String(options.html).replace(/<[^>]*>/g, '') : ''),
      confirmText: options.confirmButtonText,
      cancelText: options.cancelButtonText,
      isConfirm: Boolean(options.showCancelButton)
    });
  }

  async function confirmSafe(options) {
    const swal = await loadSwal();
    if (swal) {
      applyTheme();
      const result = await swal.fire({
        icon: options.isDangerous ? 'warning' : 'question',
        title: options.title || 'Confirmar Operação',
        html: options.text ? `<p style="margin:0;">${escapeHtml(options.text)}</p>` : undefined,
        showCancelButton: true,
        confirmButtonText: options.confirmButtonText || 'Confirmar',
        cancelButtonText: options.cancelButtonText || 'Cancelar',
        reverseButtons: true,
        focusCancel: true
      });
      return Boolean(result.isConfirmed);
    }
    return nativeFallbackPopup({
      icon: options.isDangerous ? 'warning' : 'question',
      title: options.title || 'Confirmar Operação',
      text: options.text || '',
      confirmText: options.confirmButtonText || 'Confirmar',
      cancelText: options.cancelButtonText || 'Cancelar',
      isConfirm: true
    });
  }

  // ---------------------------------------------------------------------------
  // 7. API pública (window.Alerts)
  // ---------------------------------------------------------------------------
  const Alerts = {
    // Primitivas
    async success(title, text) {
      return fireSafe({
        icon: 'success',
        title: title || 'Operação Concluída',
        html: text ? `<p style="margin:0;">${escapeHtml(text)}</p>` : undefined,
        confirmButtonText: 'Continuar',
        timer: 4000,
        timerProgressBar: true
      });
    },

    async error(title, text) {
      return fireSafe({
        icon: 'error',
        title: title || 'Ocorreu um Erro',
        html: text ? `<p style="margin:0;">${escapeHtml(text)}</p>` : undefined,
        confirmButtonText: 'Entendido'
      });
    },

    async warning(title, text) {
      return fireSafe({
        icon: 'warning',
        title: title || 'Atenção',
        html: text ? `<p style="margin:0;">${escapeHtml(text)}</p>` : undefined,
        confirmButtonText: 'Compreendido'
      });
    },

    async info(title, text) {
      return fireSafe({
        icon: 'info',
        title: title || 'Informação',
        html: text ? `<p style="margin:0;">${escapeHtml(text)}</p>` : undefined,
        confirmButtonText: 'Fechar'
      });
    },

    async toast(message, type) {
      const swal = await loadSwal();
      if (!swal) return;
      applyTheme();
      return swal.fire({
        toast: true,
        position: 'top-end',
        icon: type || 'success',
        title: message || '',
        showConfirmButton: false,
        timer: 3200,
        timerProgressBar: true
      });
    },

    async confirm(opts) {
      return confirmSafe(opts || {});
    },

    async showLoading(title, text) {
      const swal = await loadSwal();
      if (!swal) return;
      applyTheme();
      swal.fire({
        title: title || 'A processar...',
        html: text ? `<p style="margin:0;color:#94a3b8;">${escapeHtml(text)}</p>` : undefined,
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => swal.showLoading()
      });
    },

    closeLoading() {
      if (window.Swal) window.Swal.close();
    },

    // -------------------------------------------------------------------------
    // Helpers de transferência
    // -------------------------------------------------------------------------
    async transferResult(data) {
      const d = data || {};
      const amount = formatKz(d.amount);
      const recipient = d.recipientName || d.recipientEmail || 'Beneficiário';
      const ref = d.reference ? escapeHtml(d.reference) : null;

      const html = `
        <div style="text-align:left;padding:0.5rem 0;">
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#94a3b8;font-size:0.85rem;">Valor transferido</span>
            <strong style="color:#10b981;font-family:'Space Grotesk',sans-serif;font-size:1.05rem;">${amount}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#94a3b8;font-size:0.85rem;">Beneficiário</span>
            <strong style="color:#ffffff;font-size:0.9rem;">${escapeHtml(recipient)}</strong>
          </div>
          ${ref ? `
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#94a3b8;font-size:0.85rem;">Referência</span>
            <strong style="color:#8b5cf6;font-family:monospace;font-size:0.82rem;">${ref}</strong>
          </div>` : ''}
          ${d.newBalance != null ? `
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;">
            <span style="color:#94a3b8;font-size:0.85rem;">Novo saldo</span>
            <strong style="color:#ffffff;font-size:0.9rem;">${formatKz(d.newBalance)}</strong>
          </div>` : ''}
        </div>
      `;

      return fireSafe({
        icon: 'success',
        title: 'Transferência Concluída',
        html,
        confirmButtonText: 'Ver Comprovativo',
        showCancelButton: true,
        cancelButtonText: 'Fechar',
        reverseButtons: true
      });
    },

    async transferError(message) {
      return this.error('Transferência Não Concluída',
        message || 'Não foi possível processar a transferência. Verifique os dados e tente novamente.');
    },

    // -------------------------------------------------------------------------
    // Helpers de depósito
    // -------------------------------------------------------------------------
    async depositResult(data) {
      const d = data || {};
      const amount = formatKz(d.amount);
      const method = d.method || 'Multicaixa Express';
      const ref = d.reference ? escapeHtml(d.reference) : null;

      const html = `
        <div style="text-align:left;padding:0.5rem 0;">
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#94a3b8;font-size:0.85rem;">Valor a depositar</span>
            <strong style="color:#06b6d4;font-family:'Space Grotesk',sans-serif;font-size:1.05rem;">${amount}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.08);">
            <span style="color:#94a3b8;font-size:0.85rem;">Método</span>
            <strong style="color:#ffffff;font-size:0.9rem;">${escapeHtml(method)}</strong>
          </div>
          ${ref ? `
          <div style="display:flex;justify-content:space-between;padding:0.5rem 0;">
            <span style="color:#94a3b8;font-size:0.85rem;">Referência</span>
            <strong style="color:#8b5cf6;font-family:monospace;font-size:0.82rem;">${ref}</strong>
          </div>` : ''}
        </div>
      `;

      return fireSafe({
        icon: 'success',
        title: 'Depósito Iniciado',
        html,
        confirmButtonText: 'Concluir',
        showCancelButton: true,
        cancelButtonText: 'Ver Comprovativo',
        reverseButtons: true
      });
    },

    async depositError(message) {
      return this.error('Depósito Não Concluído',
        message || 'Não foi possível iniciar o depósito. Verifique os dados e tente novamente.');
    }
  };

  window.Alerts = Alerts;
  window.formatKz = window.formatKz || formatKz;

  // ---------------------------------------------------------------------------
  // 8. INTERCEPTOR NATIVO
  // ---------------------------------------------------------------------------
  // Substitui window.confirm e window.alert por versões assíncronas
  // que mostram SweetAlert bonito. Se o Swal não carregar, usa fallback próprio.
  // ---------------------------------------------------------------------------
  function installNativeInterceptor() {
    if (state.intercepting) return;
    state.intercepting = true;

    // window.confirm — agora é assíncrono e devolve Promise<boolean>
    window.confirm = function (message) {
      console.warn(
        '[OK:CONFIRM:INTERCEPTED] window.confirm() foi substituído pelo SweetAlert. ' +
        'Para fluxos que dependem de retorno síncrono, use await window.Alerts.confirm(...).'
      );
      // Devolve uma Promise — código que não espera vai receber truthy (verdadeiro),
      // o que mantém compatibilidade; código que faz `await` recebe o resultado real.
      return confirmSafe({
        title: 'Confirmação',
        text: message || 'Deseja continuar?',
        confirmButtonText: 'Confirmar',
        cancelButtonText: 'Cancelar'
      });
    };

    // window.alert — agora é assíncrono (Promise<void>)
    window.alert = function (message) {
      console.warn(
        '[OK:ALERT:INTERCEPTED] window.alert() foi substituído pelo SweetAlert. ' +
        'Para fluxos que dependem de retorno síncrono, use window.Alerts.info(...).'
      );
      fireSafe({
        icon: 'info',
        title: 'Informação',
        html: `<p style="margin:0;">${escapeHtml(message || '')}</p>`,
        confirmButtonText: 'OK'
      });
    };
  }

  // ---------------------------------------------------------------------------
  // 9. Inicialização
  // ---------------------------------------------------------------------------
  function init() {
    installNativeInterceptor();
    loadSwal().then((swal) => {
      if (swal) applyTheme();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expõe utilitários
  window.__OK_SWAL__ = {
    loadSwal,
    applyTheme,
    fireSafe,
    confirmSafe,
    formatKz,
    escapeHtml,
    restoreNative: () => {
      if (state.originalConfirm) window.confirm = state.originalConfirm;
      if (state.originalAlert) window.alert = state.originalAlert;
      state.intercepting = false;
    }
  };
})();