/**
 * ONEKIXIKILA — GRAVADOR DE ÁUDIO E NOTAS DE VOZ (Vanilla JS / Browser)
 * Controla a captura de áudio via MediaStream / MediaRecorder API,
 * codificação em codecs suportados (WebM/Opus, OGG, MP4), medição de tempo real,
 * imposição do teto máximo de 120 segundos (2 minutos) e 10 MB,
 * pré-escuta (preview) e despacho multipart para a API do chat de Kixikila.
 */

(function (window, document) {
  'use strict';

  // Configurações e limites de conformidade estritos
  const RECORDER_CONFIG = Object.freeze({
    maxDurationSeconds: 120, // 2 minutos (conforme especificação da plataforma)
    maxSizeBytes: 10485760,  // 10 MB
    preferredMimeTypes: [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/aac'
    ]
  });

  class AudioRecorder {
    constructor() {
      this.mediaRecorder = null;
      this.audioStream = null;
      this.audioChunks = [];
      this.recordingTimer = null;
      this.elapsedSeconds = 0;
      this.isRecording = false;
      this.isPaused = false;
      this.recordedBlob = null;
      this.supportedMimeType = '';

      // Elementos do DOM
      this.recordTriggerBtn = null;
      this.recordingOverlay = null;
      this.timerDisplay = null;
      this.cancelBtn = null;
      this.stopSendBtn = null;
      this.pauseBtn = null;
      this.previewPlayer = null;
    }

    /**
     * Inicializa os botões e eventos do gravador na interface
     * @param {object} [options={}]
     */
    init(options = {}) {
      this.bindDOMElements();
      if (!this.recordTriggerBtn) return;

      this.resolveSupportedMimeType();
      this.bindEvents();
    }

    /**
     * Identifica os elementos de controle na página
     */
    bindDOMElements() {
      this.recordTriggerBtn = document.querySelector('#chat-start-record-btn');
      this.recordingOverlay = document.querySelector('#chat-recording-panel');
      this.timerDisplay = document.querySelector('#chat-recording-timer');
      this.cancelBtn = document.querySelector('#chat-recording-cancel-btn');
      this.stopSendBtn = document.querySelector('#chat-recording-send-btn');
      this.pauseBtn = document.querySelector('#chat-recording-pause-btn');
      this.previewPlayer = document.querySelector('#chat-recording-preview-audio');
    }

    /**
     * Vincula ouvintes de eventos para acionamento e cancelamento
     */
    bindEvents() {
      if (this.recordTriggerBtn) {
        this.recordTriggerBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.toggleRecording();
        });
      }

      if (this.cancelBtn) {
        this.cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.cancelRecording();
        });
      }

      if (this.stopSendBtn) {
        this.stopSendBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.stopAndSend();
        });
      }

      if (this.pauseBtn) {
        this.pauseBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.togglePause();
        });
      }
    }

    /**
     * Avalia os formatos de codificação de áudio suportados nativamente pelo navegador
     */
    resolveSupportedMimeType() {
      if (typeof window.MediaRecorder === 'undefined') {
        this.supportedMimeType = '';
        return;
      }

      for (const type of RECORDER_CONFIG.preferredMimeTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          this.supportedMimeType = type;
          break;
        }
      }

      if (!this.supportedMimeType) {
        this.supportedMimeType = 'audio/webm'; // Fallback
      }
    }

    /**
     * Inicia ou comuta a gravação de áudio
     */
    async toggleRecording() {
      if (this.isRecording) {
        await this.stopAndSend();
      } else {
        await this.startRecording();
      }
    }

    /**
     * Solicita autorização de microfone e inicia a captura
     */
    async startRecording() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (window.Alerts) {
          window.Alerts.error('O seu navegador não possui suporte para gravação de áudio em tempo real.');
        }
        return;
      }

      try {
        this.audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        this.audioChunks = [];
        this.elapsedSeconds = 0;
        this.recordedBlob = null;

        const options = this.supportedMimeType ? { mimeType: this.supportedMimeType } : {};
        this.mediaRecorder = new MediaRecorder(this.audioStream, options);

        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            this.audioChunks.push(event.data);
          }
        };

        this.mediaRecorder.onstop = () => {
          this.buildRecordedBlob();
        };

        this.mediaRecorder.onerror = (recorderError) => {
          this.cleanupStream();
          if (window.Alerts) {
            window.Alerts.error('Ocorreu uma falha durante a gravação de áudio.');
          }
        };

        // Inicia captura emitindo fatias a cada 250ms
        this.mediaRecorder.start(250);
        this.isRecording = true;
        this.isPaused = false;

        this.startTimer();
        this.updateUIRecordingState(true);

        if (window.Alerts && typeof window.Alerts.toast === 'function') {
          window.Alerts.toast('Gravação de voz iniciada...', 'info', 2000);
        }
      } catch (permissionError) {
        this.cleanupStream();
        if (window.Alerts) {
          window.Alerts.warning(
            'Permissão de Microfone Negada',
            'Por favor, autorize o acesso ao microfone nas definições do seu navegador para gravar notas de voz.'
          );
        }
      }
    }

    /**
     * Pausa ou retoma a gravação em curso
     */
    togglePause() {
      if (!this.mediaRecorder || !this.isRecording) return;

      if (this.isPaused) {
        this.mediaRecorder.resume();
        this.isPaused = false;
        this.startTimer();
        if (this.pauseBtn) {
          this.pauseBtn.innerHTML = '<i class="bi bi-pause-fill"></i>';
          this.pauseBtn.title = 'Pausar gravação';
        }
      } else {
        this.mediaRecorder.pause();
        this.isPaused = true;
        this.stopTimer();
        if (this.pauseBtn) {
          this.pauseBtn.innerHTML = '<i class="bi bi-play-fill text-success"></i>';
          this.pauseBtn.title = 'Retomar gravação';
        }
      }
    }

    /**
     * Interrompe o temporizador e finaliza a gravação, despachando o ficheiro ao chat
     */
    async stopAndSend() {
      if (!this.mediaRecorder || !this.isRecording) return;

      const duration = this.elapsedSeconds;

      if (duration < 1) {
        this.cancelRecording();
        if (window.Alerts) {
          window.Alerts.warning('Nota de voz demasiado curta. Mantenha gravado pelo menos 1 segundo.');
        }
        return;
      }

      this.stopTimer();
      this.isRecording = false;

      // Aguarda o encerramento do stream e montagem do Blob
      await new Promise((resolve) => {
        const originalOnStop = this.mediaRecorder.onstop;
        this.mediaRecorder.onstop = (e) => {
          if (typeof originalOnStop === 'function') originalOnStop(e);
          resolve();
        };
        this.mediaRecorder.stop();
      });

      this.cleanupStream();
      this.updateUIRecordingState(false);

      if (!this.recordedBlob || this.recordedBlob.size === 0) {
        if (window.Alerts) window.Alerts.error('Falha ao processar o áudio gravado.');
        return;
      }

      await this.dispatchAudioMessage(this.recordedBlob, duration);
    }

    /**
     * Cancela e descarta a gravação atual sem enviar
     */
    cancelRecording() {
      this.stopTimer();
      this.isRecording = false;
      this.isPaused = false;
      this.elapsedSeconds = 0;
      this.audioChunks = [];
      this.recordedBlob = null;

      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        try {
          this.mediaRecorder.stop();
        } catch (e) {}
      }

      this.cleanupStream();
      this.updateUIRecordingState(false);

      if (window.Alerts && typeof window.Alerts.toast === 'function') {
        window.Alerts.toast('Gravação de voz descartada.', 'info', 2000);
      }
    }

    /**
     * Agrega as partes capturadas num único Blob multimédia
     */
    buildRecordedBlob() {
      const mime = this.supportedMimeType || 'audio/webm';
      this.recordedBlob = new Blob(this.audioChunks, { type: mime });
    }

    /**
     * Envia o ficheiro de áudio para a API do chat do grupo
     * @param {Blob} audioBlob
     * @param {number} durationSeconds
     */
    async dispatchAudioMessage(audioBlob, durationSeconds) {
      const groupId = document.querySelector('[data-chat-group-id]')?.getAttribute('data-chat-group-id');
      if (!groupId || !window.apiClient) {
        if (window.Alerts) window.Alerts.error('Grupo de chat não identificado para envio do áudio.');
        return;
      }

      if (audioBlob.size > RECORDER_CONFIG.maxSizeBytes) {
        if (window.Alerts) {
          window.Alerts.error('O ficheiro de áudio excede o limite máximo permitido de 10 MB.');
        }
        return;
      }

      const ext = this.supportedMimeType.includes('ogg') ? 'ogg' : this.supportedMimeType.includes('mp4') ? 'mp4' : 'webm';
      const filename = `audio_message_${Date.now()}.${ext}`;

      const formData = new FormData();
      formData.append('audio', audioBlob, filename);
      formData.append('durationSeconds', String(durationSeconds));
      formData.append('clientMessageId', `aud-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);

      try {
        if (window.Alerts) {
          window.Alerts.showLoading('A enviar nota de voz...', 'Codificando e transmitindo o áudio.');
        }

        const res = await window.apiClient.upload(`/chat/groups/${groupId}/messages/audio`, formData);

        if (window.Alerts) window.Alerts.closeLoading();

        // Se o gerenciador do chat estiver ativo na página, anexa imediatamente à conversa
        const createdMessage = res.data && res.data.message ? res.data.message : res.data;
        if (window.chatManager && typeof window.chatManager.appendMessage === 'function') {
          window.chatManager.appendMessage(createdMessage, true);
        }
      } catch (err) {
        if (window.Alerts) {
          window.Alerts.closeLoading();
          window.Alerts.error(err.message || 'Falha ao enviar a nota de voz para o grupo.');
        }
      }
    }

    /**
     * Inicia a medição do tempo de gravação em segundos
     */
    startTimer() {
      this.stopTimer();
      this.recordingTimer = setInterval(() => {
        this.elapsedSeconds += 1;
        this.updateTimerDisplay();

        // Limite máximo atingido (120 segundos / 2 minutos): encerra e despacha automaticamente
        if (this.elapsedSeconds >= RECORDER_CONFIG.maxDurationSeconds) {
          this.stopTimer();
          if (window.Alerts && typeof window.Alerts.toast === 'function') {
            window.Alerts.toast('Limite de 2 minutos atingido. Finalizando envio...', 'warning', 2500);
          }
          this.stopAndSend();
        }
      }, 1000);
    }

    /**
     * Interrompe o temporizador ativo
     */
    stopTimer() {
      if (this.recordingTimer) {
        clearInterval(this.recordingTimer);
        this.recordingTimer = null;
      }
    }

    /**
     * Formata e atualiza os dígitos do tempo no formato MM:SS
     */
    updateTimerDisplay() {
      if (!this.timerDisplay) return;

      const mins = String(Math.floor(this.elapsedSeconds / 60)).padStart(2, '0');
      const secs = String(this.elapsedSeconds % 60).padStart(2, '0');
      this.timerDisplay.textContent = `${mins}:${secs}`;

      // Alerta visual quando faltarem menos de 15 segundos para o teto de 2 minutos
      if (this.elapsedSeconds >= RECORDER_CONFIG.maxDurationSeconds - 15) {
        this.timerDisplay.classList.add('text-danger', 'fw-bold');
      } else {
        this.timerDisplay.classList.remove('text-danger', 'fw-bold');
      }
    }

    /**
     * Desliga e liberta todas as faixas do microfone no hardware do cliente
     */
    cleanupStream() {
      if (this.audioStream) {
        this.audioStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (e) {}
        });
        this.audioStream = null;
      }
    }

    /**
     * Alterna a visibilidade dos elementos da interface durante a gravação
     * @param {boolean} isRecordingActive
     */
    updateUIRecordingState(isRecordingActive) {
      if (this.recordingOverlay) {
        this.recordingOverlay.classList.toggle('d-none', !isRecordingActive);
      }

      if (this.recordTriggerBtn) {
        this.recordTriggerBtn.classList.toggle('btn-danger', isRecordingActive);
        this.recordTriggerBtn.classList.toggle('btn-light', !isRecordingActive);
      }

      const textInputWrapper = document.querySelector('#chat-text-input-wrapper');
      if (textInputWrapper) {
        textInputWrapper.classList.toggle('d-none', isRecordingActive);
      }

      if (!isRecordingActive && this.timerDisplay) {
        this.timerDisplay.textContent = '00:00';
        this.timerDisplay.classList.remove('text-danger', 'fw-bold');
      }
    }
  }

  // Instanciação e exportação global
  window.AudioRecorder = AudioRecorder;
  window.audioRecorder = new AudioRecorder();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.audioRecorder.init();
    });
  } else {
    window.audioRecorder.init();
  }
})(typeof window !== 'undefined' ? window : this, document);