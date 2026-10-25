/**
 * ONEKIXIKILA — LEITOR E SCANNER DE CÓDIGOS QR (Vanilla JS / Browser)
 * Controla a captura de vídeo em tempo real pela câmara traseira/frontal,
 * decodificação de payloads via BarcodeDetector API nativa com fallback para biblioteca jsQR,
 * upload alternativo de imagem com QR Code, consulta e validação de tokens
 * e direcionamento automatizado para fluxos de convite de grupo ou liquidação de pagamentos.
 */

(function (window, document) {
  'use strict';

  class QrScannerManager {
    constructor() {
      this.videoStream = null;
      this.videoElement = null;
      this.canvasElement = null;
      this.canvasContext = null;
      this.scanAnimationId = null;
      this.isScanning = false;
      this.hasBarcodeDetector = typeof window.BarcodeDetector !== 'undefined';
      this.barcodeDetector = null;
      this.currentFacingMode = 'environment'; // Câmara traseira por padrão

      // Elementos do DOM
      this.modalElement = null;
      this.scannerContainer = null;
      this.triggerButtons = [];
      this.fileInput = null;
      this.switchCameraBtn = null;
      this.statusBadge = null;
    }

    /**
     * Inicializa os botões e ouvintes de escaneamento na página
     */
    init() {
      this.bindDOMElements();
      this.initBarcodeDetector();
      this.bindEvents();
    }

    /**
     * Localiza os elementos da interface no DOM
     */
    bindDOMElements() {
      this.modalElement = document.querySelector('#qr-scanner-modal');
      this.videoElement = document.querySelector('#qr-video-feed');
      this.canvasElement = document.querySelector('#qr-canvas-buffer') || document.createElement('canvas');
      this.fileInput = document.querySelector('#qr-image-file-input');
      this.switchCameraBtn = document.querySelector('#qr-switch-camera-btn');
      this.statusBadge = document.querySelector('#qr-scanner-status');
      this.triggerButtons = document.querySelectorAll('[data-action="open-qr-scanner"]');

      if (this.canvasElement) {
        this.canvasContext = this.canvasElement.getContext('2d', { willReadFrequently: true });
      }
    }

    /**
     * Inicializa a API nativa BarcodeDetector se suportada pelo navegador
     */
    initBarcodeDetector() {
      if (this.hasBarcodeDetector) {
        try {
          this.barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch (e) {
          this.barcodeDetector = null;
          this.hasBarcodeDetector = false;
        }
      }
    }

    /**
     * Regista eventos de clique, seleção de ficheiro e encerramento de modal
     */
    bindEvents() {
      this.triggerButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.openScanner();
        });
      });

      if (this.switchCameraBtn) {
        this.switchCameraBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.toggleCameraFacingMode();
        });
      }

      if (this.fileInput) {
        this.fileInput.addEventListener('change', (e) => {
          this.handleImageFileScan(e);
        });
      }

      // Ao fechar o modal do Bootstrap, desliga a câmara imediatamente
      if (this.modalElement) {
        this.modalElement.addEventListener('hidden.bs.modal', () => {
          this.stopScanner();
        });
      }
    }

    /**
     * Abre a câmara e inicia o loop contínuo de escaneamento
     */
    async openScanner() {
      // Abre o modal do Bootstrap caso configurado
      if (this.modalElement && typeof bootstrap !== 'undefined') {
        const modalInstance = bootstrap.Modal.getInstance(this.modalElement) || new bootstrap.Modal(this.modalElement);
        modalInstance.show();
      }

      await this.startCamera();
    }

    /**
     * Solicita acesso ao hardware de vídeo e inicia o feed
     */
    async startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.updateStatus('O seu navegador não suporta leitura de câmara. Utilize o upload de imagem.', 'warning');
        return;
      }

      this.stopScanner();

      try {
        this.updateStatus('A inicializar câmara...', 'info');

        const constraints = {
          video: {
            facingMode: this.currentFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        };

        this.videoStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (this.videoElement) {
          this.videoElement.srcObject = this.videoStream;
          this.videoElement.setAttribute('playsinline', 'true');
          await this.videoElement.play();

          this.isScanning = true;
          this.updateStatus('Aponte para o Código QR...', 'success');
          this.scanFrameLoop();
        }
      } catch (err) {
        this.updateStatus('Acesso à câmara negado ou indisponível.', 'danger');
        if (window.Alerts) {
          window.Alerts.warning(
            'Câmara Indisponível',
            'Não foi possível aceder à câmara do dispositivo. Conceda permissão ou carregue uma imagem com o Código QR.'
          );
        }
      }
    }

    /**
     * Alterna entre a câmara traseira e a frontal
     */
    async toggleCameraFacingMode() {
      this.currentFacingMode = this.currentFacingMode === 'environment' ? 'user' : 'environment';
      await this.startCamera();
    }

    /**
     * Loop contínuo de decodificação de frames de vídeo
     */
    async scanFrameLoop() {
      if (!this.isScanning || !this.videoElement) return;

      if (this.videoElement.readyState === this.videoElement.HAVE_ENOUGH_DATA) {
        try {
          let detectedCode = null;

          // 1. Prioridade: BarcodeDetector API nativa de alto desempenho
          if (this.barcodeDetector) {
            const barcodes = await this.barcodeDetector.detect(this.videoElement);
            if (barcodes && barcodes.length > 0) {
              detectedCode = barcodes[0].rawValue;
            }
          }

          // 2. Fallback: biblioteca jsQR caso carregada globalmente
          if (!detectedCode && typeof window.jsQR !== 'undefined' && this.canvasContext) {
            const width = this.videoElement.videoWidth;
            const height = this.videoElement.videoHeight;

            if (width > 0 && height > 0) {
              this.canvasElement.width = width;
              this.canvasElement.height = height;
              this.canvasContext.drawImage(this.videoElement, 0, 0, width, height);

              const imageData = this.canvasContext.getImageData(0, 0, width, height);
              const qrResult = window.jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert'
              });

              if (qrResult && qrResult.data) {
                detectedCode = qrResult.data;
              }
            }
          }

          if (detectedCode) {
            this.handleScanSuccess(detectedCode);
            return;
          }
        } catch (scanError) {
          // Erro de frame individual ignorado para manter fluidez
        }
      }

      this.scanAnimationId = requestAnimationFrame(() => this.scanFrameLoop());
    }

    /**
     * Interrompe o feed da câmara e liberta todas as faixas de vídeo
     */
    stopScanner() {
      this.isScanning = false;

      if (this.scanAnimationId) {
        cancelAnimationFrame(this.scanAnimationId);
        this.scanAnimationId = null;
      }

      if (this.videoStream) {
        this.videoStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (e) {}
        });
        this.videoStream = null;
      }

      if (this.videoElement) {
        this.videoElement.srcObject = null;
      }
    }

    /**
     * Decodifica Código QR a partir de uma fotografia carregada pelo utilizador
     * @param {Event} event
     */
    async handleImageFileScan(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        if (window.Alerts) window.Alerts.showLoading('A analisar imagem...', 'Procurando Código QR no ficheiro.');

        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = async () => {
          URL.revokeObjectURL(objectUrl);

          let rawValue = null;

          if (this.barcodeDetector) {
            try {
              const barcodes = await this.barcodeDetector.detect(img);
              if (barcodes && barcodes.length > 0) {
                rawValue = barcodes[0].rawValue;
              }
            } catch (e) {}
          }

          if (!rawValue && typeof window.jsQR !== 'undefined') {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qr = window.jsQR(imgData.data, imgData.width, imgData.height);
            if (qr && qr.data) {
              rawValue = qr.data;
            }
          }

          if (window.Alerts) window.Alerts.closeLoading();

          if (rawValue) {
            this.handleScanSuccess(rawValue);
          } else {
            if (window.Alerts) {
              window.Alerts.warning(
                'Código Não Detectado',
                'Não foi possível localizar um Código QR nítido na imagem carregada. Tente com outra fotografia.'
              );
            }
          }
        };

        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error('Ficheiro de imagem corrompido ou ilegível.');
          }
        };

        img.src = objectUrl;
      } catch (err) {
        if (window.Alerts) {
          window.Alerts.closeLoading();
          window.Alerts.error('Falha ao processar imagem.');
        }
      } finally {
        if (this.fileInput) this.fileInput.value = '';
      }
    }

    /**
     * Processa o código decodificado com sucesso e executa a resolução no backend
     * @param {string} rawScanValue
     */
    async handleScanSuccess(rawScanValue) {
      this.stopScanner();
      this.triggerHapticFeedback();

      // Fecha o modal do scanner se estiver ativo
      if (this.modalElement && typeof bootstrap !== 'undefined') {
        const modalInstance = bootstrap.Modal.getInstance(this.modalElement);
        if (modalInstance) modalInstance.hide();
      }

      // Extrai o token do payload caso seja uma URL completa ou JSON estruturado
      const tokenCode = this.extractTokenFromScan(rawScanValue);

      if (!tokenCode) {
        if (window.Alerts) {
          window.Alerts.warning('Código Inválido', 'O conteúdo escaneado não é um Código QR reconhecido pela OneKixikila.');
        }
        return;
      }

      try {
        if (window.Alerts) {
          window.Alerts.showLoading('A consultar dados...', 'Decodificando as informações do Código QR.');
        }

        const res = await window.apiClient.post('/payments/qr/scan', { tokenCode });
        const resolvedData = res.data || {};

        if (window.Alerts) window.Alerts.closeLoading();

        // Direciona ou apresenta o fluxo de acordo com o tipo
        if (resolvedData.qrType === 'GROUP_INVITE') {
          this.handleGroupInviteResult(resolvedData);
        } else if (resolvedData.qrType === 'PAYMENT_RECEIVE' || resolvedData.qrType === 'DIRECT_TRANSFER') {
          this.handlePaymentResult(resolvedData);
        } else {
          if (window.Alerts) {
            window.Alerts.info('Código QR Reconhecido', `Tipo: ${resolvedData.qrType || 'Geral'}`);
          }
        }
      } catch (err) {
        if (window.Alerts) {
          window.Alerts.closeLoading();
          window.Alerts.error(err.message || 'Código QR expirado, já consumido ou revogado.');
        }
      }
    }

    /**
     * Extrai a chave alfanumérica do token QR a partir de URLs ou strings
     * @param {string} input
     * @returns {string|null}
     */
    extractTokenFromScan(input) {
      if (!input || typeof input !== 'string') return null;

      const trimmed = input.trim();

      // Caso 1: JSON estruturado emitido pelo backend
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.code) return parsed.code;
        } catch (e) {}
      }

      // Caso 2: URL completa da plataforma (ex: https://.../join?code=XYZ ou ?qr=XYZ)
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
          const url = new URL(trimmed);
          const codeParam = url.searchParams.get('qr') || url.searchParams.get('code') || url.searchParams.get('token');
          if (codeParam) return codeParam;
        } catch (e) {}
      }

      // Caso 3: Token puro alfanumérico com prefixos canónicos (QRP-, QRI-, etc.)
      if (/^[A-Za-z0-9_\-:]{6,128}$/.test(trimmed)) {
        return trimmed;
      }

      return null;
    }

    /**
     * Apresenta o fluxo de adesão por convite de grupo
     * @param {object} data
     */
    async handleGroupInviteResult(data) {
      const group = data.group || {};
      const formattedQuota = window.App ? window.App.formatMoney(group.contributionAmount) : `${group.contributionAmount} Kz`;

      if (window.Alerts) {
        const confirm = await window.Alerts.confirm({
          title: 'Convite para Kixikila!',
          text: `Deseja aderir ao grupo "${group.name || 'Kixikila'}"? Quota: ${formattedQuota} (${group.frequency || 'Mensal'}).`,
          confirmButtonText: 'Sim, participar no grupo'
        });

        if (!confirm) return;

        try {
          window.Alerts.showLoading('A confirmar adesão...', 'Integrando a sua conta ao grupo.');
          const acceptRes = await window.apiClient.post('/groups/invitations/accept', {
            inviteCode: data.tokenCode
          });
          window.Alerts.closeLoading();

          await window.Alerts.success('Bem-vindo!', acceptRes.message || 'Participação confirmada com sucesso.');
          const resData = acceptRes.data || {};
          window.location.href = `/groups/${resData.groupId || resData.groupSlug || ''}`;
        } catch (err) {
          window.Alerts.closeLoading();
          window.Alerts.error(err.message || 'Falha ao aceitar o convite de adesão.');
        }
      }
    }

    /**
     * Apresenta o fluxo de confirmação e liquidação de pagamento
     * @param {object} data
     */
    async handlePaymentResult(data) {
      const recipient = data.recipient || {};
      const fixedAmount = data.fixedAmount;
      const currency = data.currency || 'AOA';

      let amountToPay = fixedAmount;

      // Se o montante for aberto (definido pelo pagador), solicita o valor
      if (!fixedAmount && window.Alerts && typeof window.Alerts.prompt === 'function') {
        const inputAmount = await window.Alerts.prompt({
          title: 'Pagar via QR Code',
          text: `Destinatário: <strong>${this.escapeHtml(recipient.name || 'Utilizador OneKixikila')}</strong>`,
          inputPlaceholder: 'Montante em Kwanzas (ex: 5000)',
          confirmButtonText: 'Prosseguir'
        });

        if (!inputAmount) return;
        amountToPay = Number(inputAmount);
      }

      if (!amountToPay || amountToPay <= 0) {
        if (window.Alerts) window.Alerts.warning('Montante de pagamento inválido.');
        return;
      }

      const formatted = window.App ? window.App.formatMoney(amountToPay, currency) : `${amountToPay} Kz`;

      if (window.Alerts) {
        const confirm = await window.Alerts.confirm({
          title: 'Confirmar Pagamento?',
          text: `Serão debitados ${formatted} da sua carteira para ${recipient.name || 'o destinatário'}.`,
          confirmButtonText: 'Confirmar débito'
        });

        if (!confirm) return;

        try {
          window.Alerts.showLoading('A liquidar pagamento...', 'Processando débito na carteira e partidas dobradas.');

          const payRes = await window.apiClient.post('/payments/qr/pay', {
            tokenCode: data.tokenCode,
            amount: amountToPay
          });

          window.Alerts.closeLoading();

          await window.Alerts.success('Pagamento Concluído!', payRes.message || 'A transferência foi confirmada com sucesso.');
          window.location.href = '/wallet/statement';
        } catch (err) {
          window.Alerts.closeLoading();
          window.Alerts.error(err.message || 'Falha ao processar o pagamento via QR Code.');
        }
      }
    }

    /**
     * Atualiza o selo visual de estado do leitor
     * @param {string} text
     * @param {'info'|'success'|'warning'|'danger'} type
     */
    updateStatus(text, type = 'info') {
      if (!this.statusBadge) return;
      this.statusBadge.className = `badge bg-${type} text-wrap small mt-2`;
      this.statusBadge.textContent = text;
    }

    /**
     * Vibração suave no dispositivo em caso de leitura bem-sucedida
     */
    triggerHapticFeedback() {
      if (navigator.vibrate) {
        try {
          navigator.vibrate([40, 60, 40]);
        } catch (e) {}
      }
    }

    /**
     * Escapa caracteres HTML para prevenção XSS
     * @param {string} str
     */
    escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  }

  // Instanciação e exportação global
  window.QrScannerManager = QrScannerManager;
  window.qrScanner = new QrScannerManager();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.qrScanner.init();
    });
  } else {
    window.qrScanner.init();
  }
})(typeof window !== 'undefined' ? window : this, document);