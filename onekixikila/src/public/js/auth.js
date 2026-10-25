/**
 * ONEKIXIKILA — GESTOR DE AUTENTICAÇÃO E CONTAS (Vanilla JS / Browser)
 * Controla os fluxos de login, registo, verificação OTP com temporizador,
 * recuperação de credenciais, redefinição de palavra-passe, medição de força de senha
 * e alternância visual de visibilidade de campos de palavra-passe.
 */

(function (window, document) {
  'use strict';

  const AuthModule = {
    /**
     * Inicialização dos manipuladores de eventos de autenticação
     */
    init() {
      this.initLoginForm();
      this.initRegisterForm();
      this.initVerifyOtpForm();
      this.initForgotPasswordForm();
      this.initResetPasswordForm();
      this.initChangePasswordForm();
      this.initPasswordToggleButtons();
      this.initPasswordStrengthMeter();
    },

    /**
     * Gera ou recupera uma impressão digital anônima do navegador para o dispositivo
     * @returns {string}
     */
    resolveDeviceFingerprint() {
      let fp = window.localStorage.getItem('onekixikila_device_fp');
      if (!fp) {
        const platform = navigator.platform || 'Web';
        const userAgent = navigator.userAgent || '';
        const screenRes = `${window.screen.width}x${window.screen.height}`;
        const randomSalt = Math.random().toString(36).substring(2, 10);
        fp = btoa(`${platform}_${screenRes}_${randomSalt}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
        window.localStorage.setItem('onekixikila_device_fp', fp);
      }
      return fp;
    },

    /**
     * Determina o nome amigável do dispositivo atual
     * @returns {string}
     */
    resolveDeviceName() {
      const ua = navigator.userAgent || '';
      if (/android/i.test(ua)) return 'Dispositivo Android';
      if (/iPad|iPhone|iPod/.test(ua)) return 'Dispositivo iOS';
      if (/windows/i.test(ua)) return 'PC Windows';
      if (/macintosh|mac os x/i.test(ua)) return 'Computador Mac';
      if (/linux/i.test(ua)) return 'Computador Linux';
      return 'Navegador Web';
    },

    /**
     * Determina a categoria do dispositivo
     * @returns {'MOBILE'|'DESKTOP'|'TABLET'|'OTHER'}
     */
    resolveDeviceType() {
      const ua = navigator.userAgent || '';
      if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'TABLET';
      if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated/i.test(ua)) return 'MOBILE';
      return 'DESKTOP';
    },

    /**
     * Formulário de Início de Sessão (Login)
     */
    initLoginForm() {
      const form = document.querySelector('#login-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const identifierInput = form.querySelector('[name="identifier"]');
        const passwordInput = form.querySelector('[name="password"]');

        if (!identifierInput || !passwordInput) return;

        const identifier = identifierInput.value.trim();
        const password = passwordInput.value;

        if (!identifier || !password) {
          if (window.Alerts) {
            window.Alerts.warning('Por favor, preencha o e-mail/telemóvel e a palavra-passe.');
          }
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A autenticar...', 'Verificando as suas credenciais.');

          const payload = {
            identifier,
            password,
            deviceFingerprint: this.resolveDeviceFingerprint(),
            deviceName: this.resolveDeviceName(),
            deviceType: this.resolveDeviceType()
          };

          const response = await window.apiClient.post('/auth/login', payload);

          if (window.apiClient && response.data && response.data.accessToken) {
            window.apiClient.setAccessToken(response.data.accessToken);
            if (response.data.user) {
              window.localStorage.setItem('onekixikila_user', JSON.stringify(response.data.user));
            }
          }

          if (window.Alerts) window.Alerts.closeLoading();

          // Redireciona para URL prévia ou para o dashboard principal
          const urlParams = new URLSearchParams(window.location.search);
          const redirectUrl = urlParams.get('redirect') || '/dashboard';
          window.location.href = redirectUrl;
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha na autenticação. Verifique as suas credenciais.');
          }
          const submitBtn = form.querySelector('button[type="submit"]');
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = submitBtn.getAttribute('data-original-html') || 'Entrar';
          }
        }
      });
    },

    /**
     * Formulário de Criação de Conta (Registo)
     */
    initRegisterForm() {
      const form = document.querySelector('#register-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const fullName = form.querySelector('[name="fullName"]')?.value.trim();
        const phoneNumber = form.querySelector('[name="phoneNumber"]')?.value.trim();
        const email = form.querySelector('[name="email"]')?.value.trim();
        const password = form.querySelector('[name="password"]')?.value;
        const confirmPassword = form.querySelector('[name="confirmPassword"]')?.value;
        const termsAccepted = form.querySelector('[name="termsAccepted"]')?.checked;

        if (!fullName || !phoneNumber || !email || !password) {
          if (window.Alerts) window.Alerts.warning('Preencha todos os campos obrigatórios do formulário.');
          this.resetSubmitButton(form);
          return;
        }

        if (password !== confirmPassword) {
          if (window.Alerts) window.Alerts.error('A confirmação da palavra-passe não coincide com a palavra-passe inserida.');
          this.resetSubmitButton(form);
          return;
        }

        if (!termsAccepted) {
          if (window.Alerts) window.Alerts.warning('Deve aceitar os Termos de Serviço e a Política de Privacidade para prosseguir.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A criar conta...', 'Registando os seus dados com segurança.');

          const payload = {
            fullName,
            phoneNumber,
            email,
            password,
            termsAccepted: Boolean(termsAccepted)
          };

          const response = await window.apiClient.post('/auth/register', payload);

          if (window.Alerts) window.Alerts.closeLoading();

          // Encaminha imediatamente para validação OTP do telemóvel
          const encodedPhone = encodeURIComponent(phoneNumber);
          window.location.href = `/verify-account?type=PHONE&identifier=${encodedPhone}&registered=1`;
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            let msg = err.message || 'Erro ao criar conta.';
            if (err.details && Array.isArray(err.details)) {
              msg = err.details.map((d) => d.message).join('<br>');
            }
            window.Alerts.error('Inconsistência no Registo', msg);
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Formulário de Verificação de Conta por Código OTP
     */
    initVerifyOtpForm() {
      const form = document.querySelector('#verify-otp-form');
      if (!form) return;

      const resendBtn = document.querySelector('#resend-otp-btn');
      const timerDisplay = document.querySelector('#otp-countdown');
      let countdownSeconds = 60;
      let countdownTimer = null;

      // Inicia contagem regressiva para novo envio
      const startCountdown = () => {
        if (!resendBtn) return;
        resendBtn.disabled = true;
        countdownSeconds = 60;

        if (countdownTimer) clearInterval(countdownTimer);

        countdownTimer = setInterval(() => {
          countdownSeconds -= 1;
          if (timerDisplay) {
            timerDisplay.textContent = `(${countdownSeconds}s)`;
          }

          if (countdownSeconds <= 0) {
            clearInterval(countdownTimer);
            resendBtn.disabled = false;
            if (timerDisplay) timerDisplay.textContent = '';
          }
        }, 1000);
      };

      startCountdown();

      // Botão de reenvio de OTP
      if (resendBtn) {
        resendBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          const identifier = form.querySelector('[name="identifier"]')?.value.trim();
          const type = form.querySelector('[name="type"]')?.value || 'PHONE';

          if (!identifier) return;

          try {
            resendBtn.disabled = true;
            await window.apiClient.post('/auth/resend-otp', { identifier, type });
            if (window.Alerts) window.Alerts.toast('Novo código enviado com sucesso!', 'success');
            startCountdown();
          } catch (err) {
            resendBtn.disabled = false;
            if (window.Alerts) window.Alerts.error(err.message || 'Falha ao reenviar código.');
          }
        });
      }

      // Submissão do código numérico
      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const codeInput = form.querySelector('[name="code"]');
        const typeInput = form.querySelector('[name="type"]');
        const identifierInput = form.querySelector('[name="identifier"]');

        const code = codeInput ? codeInput.value.trim() : '';
        const type = typeInput ? typeInput.value : 'PHONE';
        const identifier = identifierInput ? identifierInput.value.trim() : '';

        if (!code || code.length < 4) {
          if (window.Alerts) window.Alerts.warning('Insira o código numérico de validação completo.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A verificar...', 'Validando o código informado.');

          await window.apiClient.post('/auth/verify-otp', { code, type, identifier });

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Conta Verificada!', 'A sua conta foi ativada com sucesso. Inicie sessão.');
          }

          window.location.href = '/login?verified=1';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Código incorreto ou expirado.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Formulário de Solicitação de Recuperação de Palavra-passe
     */
    initForgotPasswordForm() {
      const form = document.querySelector('#forgot-password-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const identifier = form.querySelector('[name="identifier"]')?.value.trim();
        if (!identifier) {
          if (window.Alerts) window.Alerts.warning('Por favor, informe o seu e-mail ou número de telemóvel.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A enviar...', 'A processar o pedido de recuperação.');

          await window.apiClient.post('/auth/forgot-password', { identifier });

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.info(
              'Instruções Enviadas',
              'Se o dado informado corresponder a uma conta registada, enviámos as instruções para redefinição de palavra-passe.'
            );
          }

          window.location.href = '/login';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao processar recuperação.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Formulário de Redefinição de Palavra-passe com Token
     */
    initResetPasswordForm() {
      const form = document.querySelector('#reset-password-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const token = form.querySelector('[name="token"]')?.value.trim();
        const newPassword = form.querySelector('[name="newPassword"]')?.value;
        const confirmPassword = form.querySelector('[name="confirmPassword"]')?.value;

        if (!token) {
          if (window.Alerts) window.Alerts.error('Token de recuperação em falta ou inválido.');
          this.resetSubmitButton(form);
          return;
        }

        if (newPassword !== confirmPassword) {
          if (window.Alerts) window.Alerts.error('A confirmação da palavra-passe não coincide com a nova palavra-passe.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A redefinir...', 'Atualizando as suas credenciais.');

          await window.apiClient.post('/auth/reset-password', { token, newPassword });

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success('Palavra-passe Atualizada', 'A sua palavra-passe foi redefinida com sucesso.');
          }

          window.location.href = '/login?reset=1';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao redefinir palavra-passe. O link pode ter expirado.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Formulário de Alteração de Palavra-passe por Utilizador Autenticado
     */
    initChangePasswordForm() {
      const form = document.querySelector('#change-password-form');
      if (!form) return;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const currentPassword = form.querySelector('[name="currentPassword"]')?.value;
        const newPassword = form.querySelector('[name="newPassword"]')?.value;
        const confirmPassword = form.querySelector('[name="confirmPassword"]')?.value;

        if (!currentPassword || !newPassword) {
          if (window.Alerts) window.Alerts.warning('Preencha a palavra-passe atual e a nova palavra-passe.');
          this.resetSubmitButton(form);
          return;
        }

        if (newPassword !== confirmPassword) {
          if (window.Alerts) window.Alerts.error('A confirmação da nova palavra-passe não coincide.');
          this.resetSubmitButton(form);
          return;
        }

        try {
          if (window.Alerts) window.Alerts.showLoading('A atualizar...', 'Modificando a sua credencial de segurança.');

          await window.apiClient.post('/auth/change-password', { currentPassword, newPassword });

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success(
              'Palavra-passe Alterada',
              'A sua palavra-passe foi alterada. Todas as outras sessões foram encerradas. Inicie sessão novamente.'
            );
          }

          if (window.apiClient) window.apiClient.clearSession();
          window.location.href = '/login';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Erro ao alterar palavra-passe. Verifique a palavra-passe atual.');
          }
          this.resetSubmitButton(form);
        }
      });
    },

    /**
     * Botões de alternância de visibilidade de palavras-passe (ícones de olho)
     */
    initPasswordToggleButtons() {
      document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
        btn.addEventListener('click', function () {
          const targetSelector = this.getAttribute('data-toggle-password');
          const targetInput = document.querySelector(targetSelector);
          if (!targetInput) return;

          const isPassword = targetInput.type === 'password';
          targetInput.type = isPassword ? 'text' : 'password';

          const icon = this.querySelector('i');
          if (icon) {
            icon.classList.toggle('bi-eye', !isPassword);
            icon.classList.toggle('bi-eye-slash', isPassword);
          }
        });
      });
    },

    /**
     * Medidor em tempo real de robustez de palavra-passe com lista de critérios
     */
    initPasswordStrengthMeter() {
      const passwordInputs = document.querySelectorAll('[data-strength-input]');
      passwordInputs.forEach((input) => {
        const meterContainer = document.querySelector(input.getAttribute('data-strength-meter'));
        if (!meterContainer) return;

        input.addEventListener('input', function () {
          const val = this.value;
          let score = 0;

          const checks = {
            length: val.length >= 8,
            upper: /[A-Z]/.test(val),
            lower: /[a-z]/.test(val),
            number: /\d/.test(val),
            special: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(val)
          };

          if (checks.length) score += 1;
          if (checks.upper && checks.lower) score += 1;
          if (checks.number) score += 1;
          if (checks.special) score += 1;

          const progressBar = meterContainer.querySelector('.progress-bar');
          const feedbackText = meterContainer.querySelector('.strength-label');

          if (progressBar) {
            const percentage = (score / 4) * 100;
            progressBar.style.width = `${percentage}%`;

            progressBar.classList.remove('bg-danger', 'bg-warning', 'bg-info', 'bg-success');
            if (score <= 1) {
              progressBar.classList.add('bg-danger');
              if (feedbackText) feedbackText.textContent = 'Fraca';
            } else if (score === 2) {
              progressBar.classList.add('bg-warning');
              if (feedbackText) feedbackText.textContent = 'Média';
            } else if (score === 3) {
              progressBar.classList.add('bg-info');
              if (feedbackText) feedbackText.textContent = 'Boa';
            } else {
              progressBar.classList.add('bg-success');
              if (feedbackText) feedbackText.textContent = 'Forte';
            }
          }
        });
      });
    },

    /**
     * Utilitário para restaurar botão de submissão após erro
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

  // Inicialização no carregamento
  window.AuthModule = AuthModule;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AuthModule.init());
  } else {
    AuthModule.init();
  }
})(typeof window !== 'undefined' ? window : this, document);