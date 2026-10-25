/**
 * ONEKIXIKILA — GESTOR DE UPLOAD DE DOCUMENTOS PRIVADOS (Vanilla JS / Browser)
 * Controla a seleção, validação no cliente, pré-visualização, arraste (drag-and-drop),
 * imposição da barreira física inegociável de 5 MB (5.242.880 bytes),
 * verificação de formatos seguros (PDF, JPEG, PNG, WEBP) e envio multipart
 * tanto para anexos de grupos de Kixikila quanto para verificação de identidade KYC.
 */

(function (window, document) {
  'use strict';

  // Configurações e limites de conformidade inegociáveis da plataforma
  const DOCUMENT_UPLOAD_CONFIG = Object.freeze({
    maxSizeBytes: 5242880, // 5 MB exatos (5.242.880 bytes)
    maxSizeFormatted: '5 MB',
    allowedMimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ],
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png', '.webp']
  });

  class DocumentUploader {
    constructor() {
      this.dropzones = [];
    }

    /**
     * Inicializa todas as áreas de upload de documentos presentes no DOM
     */
    init() {
      this.initChatDocumentUpload();
      this.initKycDocumentUpload();
      this.initGenericDropzones();
    }

    /**
     * Valida um ficheiro antes de qualquer processamento ou transmissão.
     * Rejeita estritamente ficheiros vazios (0 bytes), que ultrapassem 5.242.880 bytes
     * ou que não estejam na lista de tipos permitidos.
     *
     * @param {File} file
     * @returns {{ valid: boolean, reason?: string }}
     */
    validateFile(file) {
      if (!file) {
        return { valid: false, reason: 'Nenhum ficheiro selecionado.' };
      }

      if (file.size <= 0) {
        return { valid: false, reason: 'O ficheiro selecionado está vazio (0 bytes).' };
      }

      if (file.size > DOCUMENT_UPLOAD_CONFIG.maxSizeBytes) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
        return {
          valid: false,
          reason: `O documento excede o limite máximo autorizado de ${DOCUMENT_UPLOAD_CONFIG.maxSizeFormatted} (${DOCUMENT_UPLOAD_CONFIG.maxSizeBytes.toLocaleString('pt-AO')} bytes). Tamanho atual: ${sizeMb} MB.`
        };
      }

      const mime = (file.type || '').toLowerCase();
      const name = (file.name || '').toLowerCase();
      const hasValidExt = DOCUMENT_UPLOAD_CONFIG.allowedExtensions.some((ext) => name.endsWith(ext));
      const hasValidMime = DOCUMENT_UPLOAD_CONFIG.allowedMimeTypes.includes(mime);

      if (!hasValidExt && !hasValidMime) {
        return {
          valid: false,
          reason: `Formato de ficheiro não suportado. Os formatos aceites são: ${DOCUMENT_UPLOAD_CONFIG.allowedExtensions.join(', ')}.`
        };
      }

      return { valid: true };
    }

    /**
     * Configura o botão de anexo de documento no chat do grupo
     */
    initChatDocumentUpload() {
      const fileInput = document.querySelector('#chat-document-file-input');
      const attachBtn = document.querySelector('#chat-attach-document-btn');
      if (!fileInput || !attachBtn) return;

      attachBtn.addEventListener('click', (e) => {
        e.preventDefault();
        fileInput.value = '';
        fileInput.click();
      });

      fileInput.addEventListener('change', async () => {
        if (!fileInput.files || fileInput.files.length === 0) return;

        const file = fileInput.files[0];
        const validation = this.validateFile(file);

        if (!validation.valid) {
          if (window.Alerts) {
            window.Alerts.error('Ficheiro Não Autorizado', validation.reason);
          }
          fileInput.value = '';
          return;
        }

        const groupId = document.querySelector('[data-chat-group-id]')?.getAttribute('data-chat-group-id');
        if (!groupId) {
          if (window.Alerts) window.Alerts.error('Grupo de chat não identificado.');
          return;
        }

        // Solicita legenda opcional para o documento
        let caption = '';
        if (window.Alerts && typeof window.Alerts.prompt === 'function') {
          const promptCaption = await window.Alerts.prompt({
            title: 'Enviar Documento',
            text: `Ficheiro: <strong>${this.escapeHtml(file.name)}</strong> (${(file.size / (1024 * 1024)).toFixed(2)} MB)`,
            inputPlaceholder: 'Legenda ou descrição opcional...',
            confirmButtonText: 'Enviar Ficheiro'
          });
          if (promptCaption === null) {
            fileInput.value = '';
            return;
          }
          caption = promptCaption || '';
        }

        const formData = new FormData();
        formData.append('document', file);
        if (caption) formData.append('caption', caption);
        formData.append('clientMessageId', `doc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);

        try {
          if (window.Alerts) {
            window.Alerts.showLoading('A enviar documento...', 'Inspecionando bytes e enviando para o cofre seguro.');
          }

          const res = await window.apiClient.upload(`/chat/groups/${groupId}/messages/document`, formData);

          if (window.Alerts) window.Alerts.closeLoading();

          const message = res.data && res.data.message ? res.data.message : res.data;
          if (window.chatManager && typeof window.chatManager.appendMessage === 'function') {
            window.chatManager.appendMessage(message, true);
          }

          fileInput.value = '';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao enviar documento.');
          }
          fileInput.value = '';
        }
      });
    }

    /**
     * Configura formulários de submissão de verificação de identidade KYC (Bilhete de Identidade e Selfie)
     */
    initKycDocumentUpload() {
      const kycForm = document.querySelector('#kyc-verification-form');
      if (!kycForm) return;

      const idFileInput = kycForm.querySelector('[name="idDocument"]');
      const selfieFileInput = kycForm.querySelector('[name="facialPhoto"]');

      // Pré-visualização ao selecionar documento de identidade
      if (idFileInput) {
        idFileInput.addEventListener('change', () => {
          const file = idFileInput.files?.[0];
          if (!file) return;

          const validation = this.validateFile(file);
          if (!validation.valid) {
            if (window.Alerts) window.Alerts.error('Documento Inválido', validation.reason);
            idFileInput.value = '';
            this.clearPreview('#id-document-preview');
            return;
          }

          this.renderFilePreview(file, '#id-document-preview');
        });
      }

      // Pré-visualização ao selecionar fotografia facial
      if (selfieFileInput) {
        selfieFileInput.addEventListener('change', () => {
          const file = selfieFileInput.files?.[0];
          if (!file) return;

          const validation = this.validateFile(file);
          if (!validation.valid) {
            if (window.Alerts) window.Alerts.error('Fotografia Inválida', validation.reason);
            selfieFileInput.value = '';
            this.clearPreview('#facial-photo-preview');
            return;
          }

          this.renderFilePreview(file, '#facial-photo-preview');
        });
      }

      kycForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const idType = kycForm.querySelector('[name="idType"]')?.value || 'NATIONAL_ID';
        const idNumber = kycForm.querySelector('[name="idNumber"]')?.value.trim();
        const fullName = kycForm.querySelector('[name="fullNameOnDocument"]')?.value.trim();
        const birthDate = kycForm.querySelector('[name="birthDateOnDocument"]')?.value;
        const expirationDate = kycForm.querySelector('[name="expirationDate"]')?.value || null;

        const idDocFile = idFileInput?.files?.[0];
        const selfieFile = selfieFileInput?.files?.[0];

        if (!idNumber || !fullName || !birthDate || !idDocFile) {
          if (window.Alerts) {
            window.Alerts.warning('Preencha os dados do documento e anexe o ficheiro oficial de identificação.');
          }
          return;
        }

        const formData = new FormData();
        formData.append('idType', idType);
        formData.append('idNumber', idNumber);
        formData.append('fullNameOnDocument', fullName);
        formData.append('birthDateOnDocument', birthDate);
        if (expirationDate) formData.append('expirationDate', expirationDate);
        formData.append('idDocument', idDocFile);
        if (selfieFile) formData.append('facialPhoto', selfieFile);

        try {
          if (window.Alerts) {
            window.Alerts.showLoading('A submeter verificação...', 'Criptografando e enviando documentos para auditoria.');
          }

          const res = await window.apiClient.upload('/identity/submit', formData);

          if (window.Alerts) {
            window.Alerts.closeLoading();
            await window.Alerts.success(
              'Documentos Submetidos!',
              res.message || 'Os seus documentos foram submetidos com sucesso e encontram-se em análise de conformidade.'
            );
          }

          window.location.href = '/identity/status';
        } catch (err) {
          if (window.Alerts) {
            window.Alerts.closeLoading();
            window.Alerts.error(err.message || 'Falha ao submeter documentos de identidade.');
          }
        }
      });
    }

    /**
     * Configura áreas genéricas de arrastar e soltar (drag-and-drop dropzones)
     */
    initGenericDropzones() {
      const dropzoneElements = document.querySelectorAll('[data-document-dropzone]');
      dropzoneElements.forEach((zone) => {
        const fileInput = zone.querySelector('input[type="file"]');
        if (!fileInput) return;

        ['dragenter', 'dragover'].forEach((eventName) => {
          zone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.add('border-primary', 'bg-light');
          });
        });

        ['dragleave', 'drop'].forEach((eventName) => {
          zone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('border-primary', 'bg-light');
          });
        });

        zone.addEventListener('drop', (e) => {
          const dt = e.dataTransfer;
          const files = dt?.files;
          if (files && files.length > 0) {
            fileInput.files = files;
            const event = new Event('change', { bubbles: true });
            fileInput.dispatchEvent(event);
          }
        });

        zone.addEventListener('click', () => {
          fileInput.click();
        });
      });
    }

    /**
     * Renderiza a pré-visualização de um ficheiro de imagem ou PDF num container visual
     * @param {File} file
     * @param {string} targetSelector
     */
    renderFilePreview(file, targetSelector) {
      const container = document.querySelector(targetSelector);
      if (!container) return;

      const sizeFormatted = (file.size / (1024 * 1024)).toFixed(2);

      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          container.innerHTML = `
            <div class="position-relative d-inline-block border rounded p-1 bg-white shadow-sm mt-2">
              <img src="${e.target.result}" class="img-fluid rounded" style="max-height: 180px;" alt="Pré-visualização">
              <div class="small text-muted text-center mt-1 text-truncate" style="max-width: 200px;">
                ${this.escapeHtml(file.name)} (${sizeFormatted} MB)
              </div>
            </div>
          `;
        };
        reader.readAsDataURL(file);
      } else {
        container.innerHTML = `
          <div class="alert alert-secondary d-flex align-items-center mt-2 p-2">
            <i class="bi bi-file-earmark-pdf fs-2 text-danger me-2"></i>
            <div class="text-truncate">
              <strong>${this.escapeHtml(file.name)}</strong>
              <div class="small text-muted">${sizeFormatted} MB</div>
            </div>
          </div>
        `;
      }
    }

    /**
     * Limpa o container de pré-visualização
     * @param {string} targetSelector
     */
    clearPreview(targetSelector) {
      const container = document.querySelector(targetSelector);
      if (container) {
        container.innerHTML = '';
      }
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
  window.DocumentUploader = DocumentUploader;
  window.documentUploader = new DocumentUploader();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.documentUploader.init();
    });
  } else {
    window.documentUploader.init();
  }
})(typeof window !== 'undefined' ? window : this, document);