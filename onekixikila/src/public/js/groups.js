/**
 * ONEKIXIKILA — GESTOR DE GRUPOS DE KIXIKILA (Vanilla JS / Browser)
 * Controla os fluxos de criação de grupos, regulamentos operacionais,
 * descoberta territorial por geolocalização em Angola, pedidos de adesão,
 * deliberações de liderança (aprovar/suspender), emissão de convites,
 * calendários de rodadas e permuta amigável de turnos (Swap).
 */

(function (window, document) {
  'use strict';

  const GroupsModule = {
    /**
     * Inicialização dos manipuladores de eventos de grupos
     */
    init() {
      this.initCreateGroupForm();
      this.initFilterForm();
      this.initNearbySearchButton();
      this.initMembershipActions();
      this.initInvitationActions();
      this.initScheduleAndRotationActions();
      this.initContributionPaymentActions();
    },

    /**
     * Formulário de Criação de Grupo de Kixikila
     */
    initCreateGroupForm() {
      const form = document.querySelector('#create-group-form');
      if (!form) return;

      // Atualiza coordenadas automáticas no formulário caso o utilizador consinta
      const geoBtn = form.querySelector('#detect-location-btn');
      if (geoBtn && navigator.geolocation) {
        geoBtn.addEventListener('click', (e) => {
          e.preventDefault();
          geoBtn.disabled = true;
          geoBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> A obter...';

          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const latInput = form.querySelector('[name="location.approximateLatitude"]');
              const lngInput = form.querySelector('[name="location.approximateLongitude"]');
              if (latInput) latInput.value = pos.coords.latitude.toFixed(6);
              if (lngInput) lngInput.value = pos.coords.longitude.toFixed(6);
              geoBtn.disabled = false;
              geoBtn.innerHTML = '<i class="bi bi-geo-alt-fill text-success me-1"></i> Coordenadas captadas';
              if (window.Alerts) window.Alerts.toast('Coordenadas geográficas captadas!', 'success');
            },
            () => {
              geoBtn.disabled = false;
              geoBtn.innerHTML = '<i class="bi bi-geo-alt me-1"></i> Tentar novamente';
              if (window.Alerts) window.Alerts.warning('Não foi possível obter a sua localização. Preencha manualmente.');
            },
            { timeout: 10000, enableHighAccuracy: false }
          );
        });
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = form.querySelector('[name="name"]')?.value.trim();
        const description = form.querySelector('[name="description"]')?.value.trim() || null;
        const frequency = form.querySelector('[name="frequency"]')?.value;
        const contributionAmount = Number(form.querySelector('[name="contributionAmount"]')?.value);
        const minMembers = Number(form.querySelector('[name="minMembers"]')?.value || 3);
        const maxMembers = Number(form.querySelector('[name="maxMembers"]')?.value || 12);
        const startDate = form.querySelector('[name="startDate"]')?.value || null;
        const isPrivate = form.querySelector('[name="isPrivate"]')?.checked || false;
        const allowAutoDebit = form.querySelector('[name="allowAutoDebit"]')?.checked || false;

        // Regras
        const rotationType = form.querySelector('[name="rules.rotationType"]')?.value || 'FIXED';
        const gracePeriodDays = Number(form.querySelector('[name="rules.gracePeriodDays"]')?.value || 2);
        const lateFeeType = form.querySelector('[name="rules.lateFeeType"]')?.value || 'FIXED';
        const lateFeeValue = Number(form.querySelector('[name="rules.lateFeeValue"]')?.value || 0);
        const requireAdminApprovalToJoin = form.querySelector('[name="rules.requireAdminApprovalToJoin"]')?.checked !== false;
        const requireIdentityVerification = form.querySelector('[name="rules.requireIdentityVerification"]')?.checked !== false;
        const termsAndConditions = form.querySelector('[name="rules.termsAndConditions"]')?.value.trim() || null;

        // Localização
        const province = form.querySelector('[name="location.province"]')?.value.trim();
        const municipality = form.querySelector('[name="location.municipality"]')?.value.trim();
        const neighborhood = form.querySelector('[name="location.neighborhood"]')?.value.trim() || null;
        const latVal = form.querySelector('[name="location.approximateLatitude"]')?.value;
        const lngVal = form.querySelector('[name="location.approximateLongitude"]')?.value;

        if (!name || !frequency || !contributionAmount || !province || !municipality) {
          if (window.Alerts) window.Alerts.warning('Preencha todos os campos obrigatórios (Nome, Frequência, Quota, Província e Município).');
          this.resetSubmitButton(form);
          return;
        }

        const payload = {
          name,
          description,
          frequency,
          contributionAmount,
          minMembers,
          maxMembers,
          startDate,
          isPrivate,
          allowAutoDebit,
          rules: {
            rotationType,
            gracePeriodDays,
            lateFeeType,
            lateFeeValue,
            allowEarlyPayout: false,
            requireAdminApprovalToJoin,
            requireIdentityVerification,
            termsAndConditions
          },
          location: {
            province,
            municipality,
            neighborhood,
            approximateLatitude: latVal ? Number(latVal) : null,
            approximateLongitude: lngVal ? Number(lngVal) : null,
            radiusMeters: 5000,
            isPubliclyDiscoverable: !isPrivate
          }
        };

        try {
          if (window.Alerts) window.Alerts.showLoading('A criar grupo...', 'Fundando o grupo de Kixikila e alocando a liderança.');

          const res = await window.apiClient.post('/groups', payload);
          const group = res.data && res.data.group ? res.data.group : res.data;

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Grupo Fundado!', `O grupo "${name}" foi criado com sucesso. Você é o líder fundador.`);
          }

          window.location.href = `/groups/${group.id || group.slug}`;
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao criar grupo de Kixikila.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Filtros de Catálogo e Pesquisa de Grupos
     */
    initFilterForm() {
      const form = document.querySelector('#groups-filter-form');
      if (!form) return;

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const search = form.querySelector('[name="search"]')?.value.trim();
        const province = form.querySelector('[name="province"]')?.value.trim();
        const frequency = form.querySelector('[name="frequency"]')?.value;
        const minAmount = form.querySelector('[name="minAmount"]')?.value;
        const maxAmount = form.querySelector('[name="maxAmount"]')?.value;

        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (province) params.set('province', province);
        if (frequency) params.set('frequency', frequency);
        if (minAmount) params.set('minAmount', minAmount);
        if (maxAmount) params.set('maxAmount', maxAmount);

        window.location.href = `/groups?${params.toString()}`;
      });
    },

    /**
     * Botão de Descoberta por Proximidade Geográfica (Raio Esférico)
     */
    initNearbySearchButton() {
      const btn = document.querySelector('#find-nearby-groups-btn');
      if (!btn) return;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!navigator.geolocation) {
          if (window.Alerts) window.Alerts.error('O seu navegador não suporta geolocalização.');
          return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> A localizar grupos...';

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const lat = pos.coords.latitude.toFixed(6);
            const lng = pos.coords.longitude.toFixed(6);
            window.location.href = `/groups/nearby?latitude=${lat}&longitude=${lng}&radiusMeters=15000`;
          },
          () => {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-geo-alt-fill me-1"></i> Grupos Próximos de Mim';
            if (window.Alerts) window.Alerts.warning('Acesso à localização negado. Utilize a busca manual por província.');
          },
          { timeout: 10000, enableHighAccuracy: false }
        );
      });
    },

    /**
     * Ações de Participação, Adesão e Saída de Grupos
     */
    initMembershipActions() {
      // Solicitar adesão a grupo
      document.addEventListener('click', async (e) => {
        const joinBtn = e.target.closest('[data-action="join-group"]');
        if (!joinBtn) return;
        e.preventDefault();

        const groupId = joinBtn.getAttribute('data-group-id');
        if (!groupId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Aderir à Kixikila?',
            text: 'Deseja solicitar participação neste grupo colaborativo?',
            confirmButtonText: 'Sim, participar'
          });
          if (!confirm) return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A enviar pedido...', 'Aguarde confirmação.');
          const res = await window.apiClient.post(`/groups/${groupId}/join`, {});
          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Sucesso!', res.message || 'Pedido de adesão registado.');
          }
          window.location.reload();
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Não foi possível solicitar adesão ao grupo.');
          }
        }
      });

      // Saída voluntária do grupo
      document.addEventListener('click', async (e) => {
        const leaveBtn = e.target.closest('[data-action="leave-group"]');
        if (!leaveBtn) return;
        e.preventDefault();

        const membershipId = leaveBtn.getAttribute('data-membership-id');
        if (!membershipId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Sair do Grupo?',
            text: 'A saída só será permitida se todas as quotas e compromissos do ciclo estiverem quitados.',
            confirmButtonText: 'Confirmar saída',
            isDangerous: true
          });
          if (!confirm) return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A processar saída...', 'Validando compromissos pendentes.');
          await window.apiClient.post(`/groups/memberships/${membershipId}/leave`, {});
          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Concluído', 'A sua filiação ao grupo foi encerrada com sucesso.');
          }
          window.location.href = '/groups';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Não foi possível sair do grupo.');
          }
        }
      });

      // Aprovação de membro pela liderança
      document.addEventListener('click', async (e) => {
        const approveBtn = e.target.closest('[data-action="approve-member"]');
        if (!approveBtn) return;
        e.preventDefault();

        const membershipId = approveBtn.getAttribute('data-membership-id');
        if (!membershipId) return;

        try {
          await window.apiClient.post(`/groups/memberships/${membershipId}/approve`, {});
          if (window.Alerts) window.Alerts.toast('Membro aprovado com sucesso!', 'success');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Erro ao aprovar membro.');
        }
      });

      // Rejeição de membro pela liderança
      document.addEventListener('click', async (e) => {
        const rejectBtn = e.target.closest('[data-action="reject-member"]');
        if (!rejectBtn) return;
        e.preventDefault();

        const membershipId = rejectBtn.getAttribute('data-membership-id');
        if (!membershipId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Rejeitar Pedido?',
            text: 'Deseja rejeitar este pedido de participação no grupo?',
            confirmButtonText: 'Sim, rejeitar',
            isDangerous: true
          });
          if (!confirm) return;
        }

        try {
          await window.apiClient.post(`/groups/memberships/${membershipId}/reject`, {});
          if (window.Alerts) window.Alerts.toast('Pedido rejeitado.', 'info');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Erro ao rejeitar membro.');
        }
      });

      // Suspensão cautelar de membro pela liderança
      document.addEventListener('click', async (e) => {
        const suspendBtn = e.target.closest('[data-action="suspend-member"]');
        if (!suspendBtn) return;
        e.preventDefault();

        const membershipId = suspendBtn.getAttribute('data-membership-id');
        if (!membershipId) return;

        let reason = 'Suspensão preventiva deliberada pela liderança';
        if (window.Alerts && typeof window.Alerts.prompt === 'function') {
          const inputReason = await window.Alerts.prompt({
            title: 'Suspender Membro',
            text: 'Informe a justificativa formal para a suspensão do participante:',
            inputPlaceholder: 'Motivo da sanção disciplinar'
          });
          if (!inputReason) return;
          reason = inputReason;
        }

        try {
          await window.apiClient.post(`/groups/memberships/${membershipId}/suspend`, { reason });
          if (window.Alerts) window.Alerts.success('Membro Suspenso', 'A suspensão temporária foi aplicada com sucesso.');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Falha ao suspender membro.');
        }
      });

      // Reativação de membro suspenso
      document.addEventListener('click', async (e) => {
        const reactivateBtn = e.target.closest('[data-action="reactivate-member"]');
        if (!reactivateBtn) return;
        e.preventDefault();

        const membershipId = reactivateBtn.getAttribute('data-membership-id');
        if (!membershipId) return;

        try {
          await window.apiClient.post(`/groups/memberships/${membershipId}/reactivate`, {});
          if (window.Alerts) window.Alerts.toast('Membro reativado com sucesso!', 'success');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Erro ao reativar membro.');
        }
      });

      // Ativação formal do grupo de Kixikila (início das rotações)
      document.addEventListener('click', async (e) => {
        const activateBtn = e.target.closest('[data-action="activate-group"]');
        if (!activateBtn) return;
        e.preventDefault();

        const groupId = activateBtn.getAttribute('data-group-id');
        if (!groupId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Ativar Grupo de Kixikila?',
            text: 'Ao ativar o grupo, o ciclo financeiro terá início e as regras operacionais ficarão bloqueadas para edição unilateral.',
            confirmButtonText: 'Sim, ativar grupo'
          });
          if (!confirm) return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A ativar grupo...', 'Iniciando o ciclo de Kixikila.');
          await window.apiClient.post(`/groups/${groupId}/activate`, {});
          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Grupo Ativado!', 'O ciclo financeiro e as rodadas foram iniciados.');
          }
          window.location.reload();
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao ativar o grupo.');
          }
        }
      });
    },

    /**
     * Emissão, Partilha e Aceitação de Convites
     */
    initInvitationActions() {
      // Formulário de emissão de convite
      const inviteForm = document.querySelector('#create-invitation-form');
      if (inviteForm) {
        inviteForm.addEventListener('submit', async (e) => {
          e.preventDefault();

          const groupId = inviteForm.getAttribute('data-group-id') || inviteForm.querySelector('[name="groupId"]')?.value;
          const channel = inviteForm.querySelector('[name="channel"]')?.value || 'DIRECT_LINK';
          const invitedPhone = inviteForm.querySelector('[name="invitedPhone"]')?.value.trim() || null;
          const maxUses = Number(inviteForm.querySelector('[name="maxUses"]')?.value || 1);

          try {
            if (window.Alerts) window.Alerts.showLoading('A emitir convite...', 'Gerando código seguro.');

            const res = await window.apiClient.post(`/groups/${groupId}/invitations`, {
              channel,
              invitedPhone,
              maxUses
            });

            if (window.Alerts) window.Alerts.closeLoading();

            const inviteData = res.data || {};
            const link = inviteData.inviteLink || `${window.location.origin}/groups/join?code=${inviteData.inviteCode}`;

            // Exibe modal com o link e opção de cópia
            if (window.Alerts) {
              await window.Alerts.success(
                'Convite Gerado!',
                `Código: <strong>${inviteData.inviteCode}</strong><br><br>Ligação: <input type="text" class="form-control text-center mt-2" readonly value="${link}" onclick="this.select()">`
              );
            }

            window.location.reload();
          } catch (err) {
            if (window.Alerts) {
              window.Alerts.closeLoading();
              window.Alerts.error(err.message || 'Erro ao gerar convite.');
            }
          }
        });
      }

      // Aceitação de convite por código
      const acceptForm = document.querySelector('#accept-invitation-form');
      if (acceptForm) {
        acceptForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const inviteCode = acceptForm.querySelector('[name="inviteCode"]')?.value.trim();

          if (!inviteCode) {
            if (window.Alerts) window.Alerts.warning('Insira o código do convite.');
            return;
          }

          try {
            if (window.Alerts) window.Alerts.showLoading('A validar convite...', 'Confirmando a sua participação.');
            const res = await window.apiClient.post('/groups/invitations/accept', { inviteCode });
            if (window.Alerts) {
              window.Alerts.closeLoading();
              await window.Alerts.success('Bem-vindo à Kixikila!', res.message || 'Participação confirmada.');
            }
            const group = res.data || {};
            window.location.href = `/groups/${group.groupId || group.groupSlug || ''}`;
          } catch (err) {
            if (window.Alerts) {
              window.Alerts.closeLoading();
              window.Alerts.error(err.message || 'Código de convite inválido ou expirado.');
            }
          }
        });
      }
    },

    /**
     * Gestão de Calendários, Rodadas e Permuta de Turnos (Swap)
     */
    initScheduleAndRotationActions() {
      // Disparo de geração de cronograma
      document.addEventListener('click', async (e) => {
        const genSchedBtn = e.target.closest('[data-action="generate-schedule"]');
        if (!genSchedBtn) return;
        e.preventDefault();

        const groupId = genSchedBtn.getAttribute('data-group-id');
        if (!groupId) return;

        try {
          if (window.Alerts) window.Alerts.showLoading('A gerar cronograma...', 'Calculando datas de vencimento e tolerância.');
          await window.apiClient.post(`/groups/${groupId}/schedules/generate`, {});
          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Cronograma Gerado', 'O calendário de rodadas foi estruturado com sucesso.');
          }
          window.location.reload();
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao gerar cronograma.');
          }
        }
      });

      // Disparo de geração do plano de rotações
      document.addEventListener('click', async (e) => {
        const genRotBtn = e.target.closest('[data-action="generate-rotations"]');
        if (!genRotBtn) return;
        e.preventDefault();

        const groupId = genRotBtn.getAttribute('data-group-id');
        if (!groupId) return;

        try {
          if (window.Alerts) window.Alerts.showLoading('A ordenar beneficiários...', 'Atribuindo turnos do bolo da Kixikila.');
          await window.apiClient.post(`/groups/${groupId}/rotations/generate`, {});
          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Rotações Definidas', 'A ordem de contemplação foi homologada.');
          }
          window.location.reload();
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao gerar plano de rotações.');
          }
        }
      });

      // Solicitação de permuta amigável de turno (Swap)
      const swapForm = document.querySelector('#request-turn-swap-form');
      if (swapForm) {
        swapForm.addEventListener('submit', async (e) => {
          e.preventDefault();

          const groupId = swapForm.getAttribute('data-group-id');
          const targetUserId = swapForm.querySelector('[name="targetUserId"]')?.value;
          const reason = swapForm.querySelector('[name="reason"]')?.value.trim() || 'Troca consensual de data de recebimento';

          if (!targetUserId) {
            if (window.Alerts) window.Alerts.warning('Selecione o membro com quem deseja permutar o turno.');
            return;
          }

          try {
            if (window.Alerts) window.Alerts.showLoading('A enviar pedido...', 'Aguardando homologação da liderança.');
            await window.apiClient.post(`/groups/${groupId}/rotations/swap`, { targetUserId, reason });
            if (window.Alerts) {
              window.Alerts.closeLoading();
              await window.Alerts.success('Pedido Submetido', 'A solicitação de permuta foi encaminhada para homologação.');
            }
            window.location.reload();
          } catch (err) {
            if (window.Alerts) {
              window.Alerts.closeLoading();
              window.Alerts.error(err.message || 'Não foi possível solicitar a permuta.');
            }
          }
        });
      }

      // Homologação de troca de turno pela liderança
      document.addEventListener('click', async (e) => {
        const approveSwapBtn = e.target.closest('[data-action="approve-swap"]');
        if (!approveSwapBtn) return;
        e.preventDefault();

        const groupId = approveSwapBtn.getAttribute('data-group-id');
        const assignmentId = approveSwapBtn.getAttribute('data-assignment-id');

        try {
          await window.apiClient.post(`/groups/${groupId}/rotations/assignments/${assignmentId}/approve-swap`, {});
          if (window.Alerts) window.Alerts.toast('Troca de turno homologada com sucesso!', 'success');
          window.location.reload();
        } catch (err) {
          if (window.Alerts) window.Alerts.error(err.message || 'Erro ao homologar permuta.');
        }
      });
    },

    /**
     * Liquidação e Pagamento de Quotas de Contribuição
     */
    initContributionPaymentActions() {
      document.addEventListener('click', async (e) => {
        const payBtn = e.target.closest('[data-action="pay-quota"]');
        if (!payBtn) return;
        e.preventDefault();

        const obligationId = payBtn.getAttribute('data-obligation-id');
        const amount = payBtn.getAttribute('data-amount');
        const formattedAmount = window.App ? window.App.formatMoney(amount) : `${amount} Kz`;

        if (!obligationId) return;

        if (window.Alerts) {
          const confirm = await window.Alerts.confirm({
            title: 'Pagar Quota de Kixikila?',
            text: `Confirmar liquidação no valor de ${formattedAmount} debitando da sua carteira interna?`,
            confirmButtonText: 'Sim, pagar quota'
          });
          if (!confirm) return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A liquidar quota...', 'Processando débito na carteira digital.');

          const res = await window.apiClient.post('/groups/contributions/pay', {
            obligationId,
            paymentMethod: 'INTERNAL_WALLET'
          });

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Quota Liquidada!', res.message || 'Contribuição confirmada com sucesso.');
          }

          window.location.reload();
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao liquidar quota de Kixikila.');
          }
        }
      });
    },

    /**
     * Restaura visual do botão após interrupção
     * @param {HTMLFormElement} form
     */
    resetSubmitButton(form) {
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = submitBtn.getAttribute('data-original-html') || 'Submeter';
      }
    }
  };

  // Exportação e inicialização
  window.GroupsModule = GroupsModule;
  window.Groups = GroupsModule;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => GroupsModule.init());
  } else {
    GroupsModule.init();
  }
})(typeof window !== 'undefined' ? window : this, document);