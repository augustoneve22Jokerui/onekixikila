/**
 * ONEKIXIKILA — GESTOR DE CHECKOUT E PAGAMENTOS EXTERNOS (Vanilla JS / Browser)
 * Controla os fluxos de checkout com gateways angolanos (Multicaixa Express, Unitel Money, e-Kwanza),
 * polling ativo de confirmação de transações, temporizador regressivo de expiração,
 * emissão de Códigos QR dinâmicos de cobrança e disparos de conciliação financeira.
 */

(function (window, document) {
  'use strict';

  const PaymentsModule = {
    /**
     * Intervalo de sondagem de estado do pagamento em milissegundos (4 segundos)
     */
    pollingIntervalMs: 4000,
    activePollingTimer: null,
    countdownTimer: null,

    /**
     * Inicialização dos manipuladores de eventos de pagamentos
     */
    init() {
      this.initCheckoutForm();
      this.initPaymentQrGenerator();
      this.initPaymentCancellation();
      this.initStatusPollingFromPage();
      this.initReconciliationActions();
    },

    /**
     * Formulário de Checkout e Pagamento Externo
     */
    initCheckoutForm() {
      const form = document.querySelector('#payment-checkout-form');
      if (!form) return;

      const providerRadios = form.querySelectorAll('[name="provider"]');
      const channelSelect = form.querySelector('[name="channel"]');
      const phoneContainer = form.querySelector('#phone-field-wrapper');
      const phoneInput = form.querySelector('[name="phoneNumber"]');

      // Atualiza os campos de telefone e canais de acordo com o prestador selecionado
      const updateProviderUI = (provider) => {
        if (!phoneContainer) return;
        if (provider === 'MULTICAIXA_EXPRESS' || provider === 'UNITEL_MONEY') {
          phoneContainer.classList.remove('d-none');
          if (phoneInput) phoneInput.required = true;
        } else {
          phoneContainer.classList.add('d-none');
          if (phoneInput) phoneInput.required = false;
        }
      };

      providerRadios.forEach((radio) => {
        radio.addEventListener('change', function () {
          if (this.checked) updateProviderUI(this.value);
        });
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const amount = Number(form.querySelector('[name="amount"]')?.value);
        const providerRadio = form.querySelector('[name="provider"]:checked');
        const provider = providerRadio ? providerRadio.value : form.querySelector('[name="provider"]')?.value;
        const channel = channelSelect ? channelSelect.value : 'MOBILE';
        const phoneNumber = phoneInput ? phoneInput.value.trim() : null;
        const description = form.querySelector('[name="description"]')?.value.trim() || 'Pagamento OneKixikila';
        const groupId = form.querySelector('[name="groupId"]')?.value || null;
        const contributionId = form.querySelector('[name="contributionId"]')?.value || null;
        const depositId = form.querySelector('[name="depositId"]')?.value || null;

        if (!amount || amount < 100) {
          if (window.Alerts) window.Alerts.warning('O montante mínimo de pagamento é de 100 Kz.');
          this.resetSubmitButton(form);
          return;
        }

        if (!provider) {
          if (window.Alerts) window.Alerts.warning('Selecione o prestador de pagamento pretendido.');
          this.resetSubmitButton(form);
          return;
        }

        if ((provider === 'MULTICAIXA_EXPRESS' || provider === 'UNITEL_MONEY') && channel === 'MOBILE' && !phoneNumber) {
          if (window.Alerts) window.Alerts.warning('O número de telemóvel angolano é obrigatório para débitos móveis.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A conectar ao gateway...', 'Gerando ordem de pagamento interbancária.');

          const payload = {
            provider,
            channel,
            amount,
            phoneNumber,
            description,
            groupId,
            contributionId,
            depositId
          };

          const res = await window.apiClient.post('/payments/initiate', payload);
          const paymentData = res.data || {};

          if (window.Alerts) window.Alerts.closeLoading();

          // Apresenta tela ou modal de acompanhamento da ordem
          this.renderPaymentPendingModal(paymentData, amount);
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao iniciar pagamento junto ao prestador.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Apresenta o modal de aguardo de autorização e inicia polling ativo
     * @param {object} paymentData
     * @param {number} amount
     */
    renderPaymentPendingModal(paymentData, amount) {
      const formatted = window.App ? window.App.formatMoney(amount) : `${amount} Kz`;
      let contentHtml = `
        <div class="text-center p-2">
          <h5 class="fw-bold mb-3">Ordem de Pagamento: ${formatted}</h5>
          <p class="text-muted small">Referência Comercial: <code>${paymentData.merchantReference || '—'}</code></p>
      `;

      if (paymentData.qrPayload) {
        contentHtml += `
          <div class="my-3">
            <img src="${paymentData.qrPayload}" class="img-fluid border rounded p-2" style="max-width: 220px;" alt="QR Code">
            <p class="small text-muted mt-1">Escaneie o QR Code no seu aplicativo bancário.</p>
          </div>
        `;
      } else {
        contentHtml += `
          <div class="alert alert-warning text-start my-3">
            <div class="d-flex align-items-center">
              <span class="spinner-grow spinner-grow-sm text-warning me-2" role="status"></span>
              <strong>Aguardando confirmação...</strong>
            </div>
            <p class="small mb-0 mt-2">Autorize o pagamento de <strong>${formatted}</strong> no seu telemóvel.</p>
          </div>
        `;
      }

      contentHtml += `
          <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top small text-muted">
            <span>Tempo restante:</span>
            <span id="payment-countdown-display" class="fw-bold text-danger">15:00</span>
          </div>
        </div>
      `;

      if (window.Alerts && window.Swal) {
        window.Swal.fire({
          title: 'Pagamento em Processamento',
          html: contentHtml,
          showCancelButton: true,
          cancelButtonText: 'Cancelar Ordem',
          showConfirmButton: false,
          allowOutsideClick: false,
          didOpen: () => {
            this.startCountdown(15 * 60);
            this.startPolling(paymentData.paymentRequestId);
          },
          willClose: () => {
            this.stopPolling();
            this.stopCountdown();
          }
        }).then((result) => {
          if (result.dismiss === window.Swal.DismissReason.cancel) {
            this.cancelPaymentRequest(paymentData.paymentRequestId);
          }
        });
      }
    },

    /**
     * Inicia a contagem regressiva de expiração do pagamento no modal
     * @param {number} totalSeconds
     */
    startCountdown(totalSeconds) {
      let remaining = totalSeconds;
      const displayEl = document.querySelector('#payment-countdown-display');

      this.stopCountdown();
      this.countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          this.stopCountdown();
          this.stopPolling();
          if (window.Alerts) window.Alerts.warning('Tempo Expirado', 'O tempo limite para autorização da transação expirou.');
          return;
        }

        const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
        const secs = String(remaining % 60).padStart(2, '0');
        if (displayEl) displayEl.textContent = `${mins}:${secs}`;
      }, 1000);
    },

    stopCountdown() {
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }
    },

    /**
     * Inicia sondagem (polling) do estado da transação junto ao backend
     * @param {string} paymentId
     */
    startPolling(paymentId) {
      this.stopPolling();

      this.activePollingTimer = setInterval(async () => {
        try {
          const res = await window.apiClient.get(`/payments/${paymentId}/status`);
          const payment = res.data && res.data.payment ? res.data.payment : res.data;

          if (payment.status === 'SUCCEEDED' || payment.status === 'SETTLED') {
            this.stopPolling();
            this.stopCountdown();

            if (window.Alerts) {
              await window.Alerts.success('Pagamento Confirmado!', 'A transação foi liquidada e confirmada com sucesso.');
            }
            window.location.reload();
          } else if (payment.status === 'FAILED') {
            this.stopPolling();
            this.stopCountdown();

            if (window.Alerts) {
              window.Alerts.error('Pagamento Recusado', 'A transação foi recusada pelo prestador ou cancelada.');
            }
          } else if (payment.status === 'EXPIRED') {
            this.stopPolling();
            this.stopCountdown();

            if (window.Alerts) {
              window.Alerts.warning('Ordem Expirada', 'O tempo para confirmação do pagamento expirou.');
            }
          }
        } catch (pollErr) {
          // Mantém polling em caso de oscilações pontuais de rede
        }
      }, this.pollingIntervalMs);
    },

    stopPolling() {
      if (this.activePollingTimer) {
        clearInterval(this.activePollingTimer);
        this.activePollingTimer = null;
      }
    },

    /**
     * Cancela uma ordem de pagamento pendente
     * @param {string} paymentId
     */
    async cancelPaymentRequest(paymentId) {
      try {
        await window.apiClient.post(`/payments/${paymentId}/cancel`, {});
        if (window.Alerts) window.Alerts.toast('Ordem cancelada.', 'info');
      } catch (e) {}
    },

    /**
     * Emissão de Código QR Dinâmico para Cobrança ou Recebimento
     */
    initPaymentQrGenerator() {
      const form = document.querySelector('#generate-payment-qr-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const amountVal = form.querySelector('[name="fixedAmount"]')?.value;
        const fixedAmount = amountVal && Number(amountVal) > 0 ? Number(amountVal) : null;
        const description = form.querySelector('[name="description"]')?.value.trim() || 'Cobrança via QR Code OneKixikila';

        try {
          if (window.Alerts) window.Alerts.showLoading('A gerar QR Code...', 'Criando token criptográfico de cobrança.');

          const res = await window.apiClient.post('/payments/qr/generate', {
            fixedAmount,
            description,
            maxScans: 1,
            expiresInMinutes: 15
          });

          if (window.Alerts) window.Alerts.closeLoading();

          const qrData = res.data || {};
          const container = document.querySelector('#payment-qr-result-container');

          if (container && qrData.qrCodeDataUrl) {
            container.innerHTML = `
              <div class="card border-0 shadow-sm p-4 text-center my-3">
                <h5 class="fw-bold mb-2">QR Code de Cobrança</h5>
                ${fixedAmount ? `<p class="badge bg-success fs-6">${window.App ? window.App.formatMoney(fixedAmount) : fixedAmount + ' Kz'}</p>` : '<p class="text-muted small">Valor a definir pelo pagador</p>'}
                <div class="my-3">
                  <img src="${qrData.qrCodeDataUrl}" class="img-fluid border rounded p-2" style="max-width: 250px;" alt="QR Code">
                </div>
                <p class="text-muted small mb-0">Válido por 15 minutos (uso único)</p>
              </div>
            `;
            container.classList.remove('d-none');
            container.scrollIntoView({ behavior: 'smooth' });
          }
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao gerar Código QR de cobrança.');
          }
        }
      });
    },

    /**
     * Ações de Cancelamento em Listagens
     */
    initPaymentCancellation() {
      document.addEventListener('click', async (e) => {
        const cancelBtn = e.target.closest('[data-action="cancel-payment"]');
        if (!cancelBtn) return;
        e.preventDefault();

        const paymentId = cancelBtn.getAttribute('data-payment-id');
        if (!paymentId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Cancelar Pagamento?',
            text: 'Deseja cancelar esta ordem de pagamento pendente?',
            confirmButtonText: 'Sim, cancelar ordem',
            isDangerous: true
          });
          if (!confirm) return;
        }

        try {
          await window.apiClient.post(`/payments/${paymentId}/cancel`, {});
          if (window.Alerts) window.Alerts.toast('Ordem cancelada com sucesso.', 'info');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Erro ao cancelar ordem de pagamento.');
        }
      });
    },

    /**
     * Se a página atual for de visualização de pagamento pendente, inicia polling automaticamente
     */
    initStatusPollingFromPage() {
      const trackerEl = document.querySelector('[data-auto-poll-payment-id]');
      if (!trackerEl) return;

      const paymentId = trackerEl.getAttribute('data-auto-poll-payment-id');
      const status = trackerEl.getAttribute('data-payment-status');

      if (paymentId && (status === 'PENDING' || status === 'PROCESSING')) {
        this.startPolling(paymentId);
      }
    },

    /**
     * Ações de Conciliação Financeira para Operadores e Auditores
     */
    initReconciliationActions() {
      const reconForm = document.querySelector('#trigger-reconciliation-form');
      if (reconForm) {
        reconForm.addEventListener('submit', async (e) => {
          e.preventDefault();

          const provider = reconForm.querySelector('[name="provider"]')?.value;
          const startDate = reconForm.querySelector('[name="startDate"]')?.value;
          const endDate = reconForm.querySelector('[name="endDate"]')?.value;

          if (!provider || !startDate || !endDate) {
            if (window.Alerts) window.Alerts.warning('Selecione o prestador e o intervalo de datas completo.');
            return;
          }

          try {
            if (window.Alerts) window.Alerts.showLoading('A conciliar lote...', 'Cruzando transações do razão com os extratos bancários.');

            const res = await window.apiClient.post('/payments/reconciliation/run', {
              provider,
              startDate,
              endDate
            });

            if (window.Alerts) {
              window.Alerts.closeLoading();
              const batch = res.data || {};
              await window.Alerts.success(
                'Conciliação Concluída',
                `Lote [${batch.batchReference || '—'}] processado com status: <strong>${batch.status || 'OK'}</strong>.`
              );
            }

            window.location.reload();
          } catch (err) {
            if (window.Alerts) {
              window.Alerts.closeLoading();
              window.Alerts.error(err.message || 'Falha ao executar conciliação.');
            }
          }
        });
      }
    },

    /**
     * Utilitário para restaurar botão após término
     * @param {HTMLFormElement} form
     */
    resetSubmitButton(form) {
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = submitBtn.getAttribute('data-original-html') || 'Confirmar';
      }
    }
  };

  // Exportação e inicialização
  window.PaymentsModule = PaymentsModule;
  window.Payments = PaymentsModule;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PaymentsModule.init());
  } else {
    PaymentsModule.init();
  }
})(typeof window !== 'undefined' ? window : this, document);