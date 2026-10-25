/**
 * ONEKIXIKILA — GESTOR DA CARTEIRA DIGITAL (Vanilla JS / Browser)
 * Controla visualização de saldos em Kwanzas (disponível, retido e contabilístico),
 * fluxos de depósito (Multicaixa Express, Unitel Money, e-Kwanza), levantamentos
 * para IBAN bancário angolano, transferências diretas P2P, extrato paginado e recibos.
 */

(function (window, document) {
  'use strict';

  const WalletModule = {
    /**
     * Inicialização dos manipuladores de eventos da carteira
     */
    init() {
      this.initDepositForm();
      this.initWithdrawalForm();
      this.initTransferForm();
      this.initStatementFilter();
      this.initCancellationHandlers();
      this.initReceiptPrinter();
    },

    /**
     * Atualiza os dados de saldo na interface consultando a API REST
     */
    async refreshBalances() {
      try {
        if (!window.apiClient) return;
        const res = await window.apiClient.get('/wallet/me');
        const wallet = res.data && res.data.wallet ? res.data.wallet : res.data;

        if (!wallet) return;

        const availableEl = document.querySelector('#wallet-available-balance, [data-wallet-field="available"]');
        const lockedEl = document.querySelector('#wallet-locked-balance, [data-wallet-field="locked"]');
        const ledgerEl = document.querySelector('#wallet-ledger-balance, [data-wallet-field="ledger"]');

        const format = (val) => (window.App ? window.App.formatMoney(val) : `${val} Kz`);

        if (availableEl) availableEl.textContent = format(wallet.availableBalance);
        if (lockedEl) lockedEl.textContent = format(wallet.lockedBalance);
        if (ledgerEl) ledgerEl.textContent = format(wallet.ledgerBalance);
      } catch (err) {
        // Falha silenciosa de atualização em segundo plano
      }
    },

    /**
     * Formulário de Depósito de Fundos na Carteira
     */
    initDepositForm() {
      const form = document.querySelector('#deposit-form');
      if (!form) return;

      const providerSelect = form.querySelector('[name="provider"]');
      const phoneContainer = form.querySelector('#phone-field-container');
      const phoneInput = form.querySelector('[name="phoneNumber"]');

      // Alterna exibição de campo de telefone conforme prestador
      if (providerSelect && phoneContainer) {
        providerSelect.addEventListener('change', function () {
          const val = this.value;
          if (val === 'MULTICAIXA_EXPRESS' || val === 'UNITEL_MONEY') {
            phoneContainer.classList.remove('d-none');
            if (phoneInput) phoneInput.required = true;
          } else {
            phoneContainer.classList.add('d-none');
            if (phoneInput) phoneInput.required = false;
          }
        });
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const amount = Number(form.querySelector('[name="amount"]')?.value);
        const provider = form.querySelector('[name="provider"]')?.value;
        const phoneNumber = form.querySelector('[name="phoneNumber"]')?.value.trim() || null;

        if (!amount || amount < 100) {
          if (window.Alerts) window.Alerts.warning('O montante mínimo para depósito é de 100 Kz.');
          this.resetSubmitButton(form);
          return;
        }

        if (!provider) {
          if (window.Alerts) window.Alerts.warning('Selecione o método de pagamento.');
          this.resetSubmitButton(form);
          return;
        }

        if ((provider === 'MULTICAIXA_EXPRESS' || provider === 'UNITEL_MONEY') && !phoneNumber) {
          if (window.Alerts) window.Alerts.warning('Informe o número de telemóvel associado à sua conta.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A iniciar depósito...', 'Comunicando com o gateway de pagamento.');

          const payload = {
            amount,
            provider,
            phoneNumber
          };

          const res = await window.apiClient.post('/wallet/deposits', payload);
          const deposit = res.data || {};

          if (window.Alerts) {
            window.Alerts.closeLoading();

            const formattedAmount = window.App ? window.App.formatMoney(amount) : `${amount} Kz`;
            let modalHtml = `<p>Intenção de depósito de <strong>${formattedAmount}</strong> registada com sucesso.</p>`;

            if (deposit.qrPayload) {
              modalHtml += `<div class="text-center my-3"><img src="${deposit.qrPayload}" class="img-fluid border p-2" style="max-width:200px;"><p class="text-muted small mt-1">Escaneie o QR Code no seu aplicativo.</p></div>`;
            } else {
              modalHtml += `<div class="alert alert-info text-start small mt-3"><i class="bi bi-phone me-1"></i> Autorize o débito de <strong>${formattedAmount}</strong> na notificação enviada para o seu telemóvel.</div>`;
            }

            await window.Alerts.info('Aguardando Confirmação', modalHtml);
          }

          window.location.href = '/wallet/statement';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao iniciar depósito.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Formulário de Levantamento de Fundos (Withdrawal)
     */
    initWithdrawalForm() {
      const form = document.querySelector('#withdrawal-form');
      if (!form) return;

      const destinationTypeSelect = form.querySelector('[name="destinationType"]');
      const accountLabel = form.querySelector('#destination-account-label');
      const accountInput = form.querySelector('[name="destinationAccount"]');

      if (destinationTypeSelect && accountLabel && accountInput) {
        destinationTypeSelect.addEventListener('change', function () {
          if (this.value === 'BANK_ACCOUNT_IBAN') {
            accountLabel.textContent = 'IBAN Bancário Angolano (AO06...)';
            accountInput.placeholder = 'AO06 0000 0000 0000 0000 0000 0';
          } else {
            accountLabel.textContent = 'Número de Telemóvel Associado';
            accountInput.placeholder = '923 000 000';
          }
        });
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const amount = Number(form.querySelector('[name="amount"]')?.value);
        const destinationType = form.querySelector('[name="destinationType"]')?.value;
        const destinationAccount = form.querySelector('[name="destinationAccount"]')?.value.trim();
        const destinationHolderName = form.querySelector('[name="destinationHolderName"]')?.value.trim();

        if (!amount || amount <= 0) {
          if (window.Alerts) window.Alerts.warning('Informe um montante válido para levantamento.');
          this.resetSubmitButton(form);
          return;
        }

        if (!destinationAccount || !destinationHolderName) {
          if (window.Alerts) window.Alerts.warning('Preencha os dados completos da conta e titular de destino.');
          this.resetSubmitButton(form);
          return;
        }

        const formattedAmount = window.App ? window.App.formatMoney(amount) : `${amount} Kz`;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Confirmar Levantamento?',
            text: `Serão levantados ${formattedAmount} para ${destinationHolderName} (${destinationAccount}). Os fundos serão reservados até à liquidação bancária.`,
            confirmButtonText: 'Confirmar levantamento'
          });
          if (!confirm) {
            this.resetSubmitButton(form);
            return;
          }
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A submeter pedido...', 'Reservando os fundos na sua carteira.');

          const payload = {
            amount,
            destinationType,
            destinationAccount,
            destinationHolderName
          };

          const res = await window.apiClient.post('/wallet/withdrawals', payload);

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Pedido Registado!', res.message || 'O levantamento foi enviado para processamento bancário.');
          }

          window.location.href = '/wallet/statement';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Não foi possível solicitar o levantamento.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Formulário de Transferência Direta entre Membros (P2P)
     */
    initTransferForm() {
      const form = document.querySelector('#transfer-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const recipientIdentifier = form.querySelector('[name="recipientIdentifier"]')?.value.trim();
        const amount = Number(form.querySelector('[name="amount"]')?.value);
        const description = form.querySelector('[name="description"]')?.value.trim() || 'Transferência interna OneKixikila';

        if (!recipientIdentifier) {
          if (window.Alerts) window.Alerts.warning('Informe o e-mail ou número de telefone do destinatário.');
          this.resetSubmitButton(form);
          return;
        }

        if (!amount || amount <= 0) {
          if (window.Alerts) window.Alerts.warning('Informe um montante de transferência válido.');
          this.resetSubmitButton(form);
          return;
        }

        const formattedAmount = window.App ? window.App.formatMoney(amount) : `${amount} Kz`;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Confirmar Transferência?',
            text: `Deseja transferir ${formattedAmount} para o destinatário [${recipientIdentifier}] com liquidação imediata?`,
            confirmButtonText: 'Sim, transferir'
          });
          if (!confirm) {
            this.resetSubmitButton(form);
            return;
          }
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A transferir...', 'Executando débito e crédito atômicos no razão.');

          const payload = {
            recipientIdentifier,
            amount,
            description
          };

          const res = await window.apiClient.post('/wallet/transfers', payload);

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Transferência Concluída!', res.message || `Transferência de ${formattedAmount} realizada com sucesso.`);
          }

          window.location.href = '/wallet/statement';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao realizar transferência interna.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Filtros de Consulta do Extrato Financeiro
     */
    initStatementFilter() {
      const form = document.querySelector('#wallet-statement-filter-form');
      if (!form) return;

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const operationType = form.querySelector('[name="operationType"]')?.value;
        const startDate = form.querySelector('[name="startDate"]')?.value;
        const endDate = form.querySelector('[name="endDate"]')?.value;

        const params = new URLSearchParams();
        if (operationType) params.set('operationType', operationType);
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);

        window.location.href = `/wallet/statement?${params.toString()}`;
      });
    },

    /**
     * Ações de Cancelamento Voluntário de Depósitos ou Levantamentos Pendentes
     */
    initCancellationHandlers() {
      // Cancelar depósito pendente
      document.addEventListener('click', async (e) => {
        const cancelDepBtn = e.target.closest('[data-action="cancel-deposit"]');
        if (!cancelDepBtn) return;
        e.preventDefault();

        const depositId = cancelDepBtn.getAttribute('data-deposit-id');
        if (!depositId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Cancelar Depósito?',
            text: 'Deseja anular esta intenção de depósito pendente?',
            confirmButtonText: 'Sim, cancelar',
            isDangerous: true
          });
          if (!confirm) return;
        }

        try {
          await window.apiClient.post(`/wallet/deposits/${depositId}/cancel`, {});
          if (window.Alerts) window.Alerts.toast('Depósito cancelado com sucesso.', 'info');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Erro ao cancelar depósito.');
        }
      });

      // Cancelar levantamento pendente (desfaz reserva de saldo)
      document.addEventListener('click', async (e) => {
        const cancelWthBtn = e.target.closest('[data-action="cancel-withdrawal"]');
        if (!cancelWthBtn) return;
        e.preventDefault();

        const withdrawalId = cancelWthBtn.getAttribute('data-withdrawal-id');
        if (!withdrawalId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Cancelar Levantamento?',
            text: 'Os fundos reservados voltarão imediatamente para o seu saldo disponível.',
            confirmButtonText: 'Sim, cancelar pedido'
          });
          if (!confirm) return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A cancelar...', 'Restituindo o saldo disponível.');
          const res = await window.apiClient.post(`/wallet/withdrawals/${withdrawalId}/cancel`, {});
          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Pedido Cancelado', res.message || 'Os fundos foram restituídos com sucesso.');
          }
          window.location.reload();
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao cancelar levantamento.');
          }
        }
      });
    },

    /**
     * Utilitário para impressão ou download do recibo oficial da transação
     */
    initReceiptPrinter() {
      const printBtn = document.querySelector('#print-receipt-btn');
      if (printBtn) {
        printBtn.addEventListener('click', () => {
          window.print();
        });
      }
    },

    /**
     * Utilitário de recuperação de botão após interrupção
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
  window.WalletModule = WalletModule;
  window.Wallet = WalletModule;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WalletModule.init());
  } else {
    WalletModule.init();
  }
})(typeof window !== 'undefined' ? window : this, document);