const nodemailer = require('nodemailer');
const { query } = require('../database/query');
const notificationsConfig = require('../config/notifications');
const logger = require('../shared/logging/logger');

/**
 * Tarefa agendada para processamento e despacho da fila de notificações multicanal
 * (In-App, SMS via gateway nacional angolano e E-mail via SMTP do cPanel).
 */
class NotificationsJob {
  constructor() {
    this.logger = logger.child({ module: 'NOTIFICATIONS_JOB' });
    
    if (notificationsConfig.channels.email.enabled) {
      this.emailTransporter = nodemailer.createTransport({
        host: notificationsConfig.channels.email.host,
        port: notificationsConfig.channels.email.port,
        secure: notificationsConfig.channels.email.port === 465,
        auth: {
          user: notificationsConfig.channels.email.auth.user,
          pass: notificationsConfig.channels.email.auth.pass
        },
        tls: { rejectUnauthorized: false },
        pool: true,
        maxConnections: 3,
        maxMessages: 100
      });
    }
  }

  /**
   * Executa uma rodada de processamento de notificações pendentes.
   */
  async run() {
    const batchSize = notificationsConfig.queue.batchSize || 25;
    const maxRetries = notificationsConfig.queue.maxRetries || 3;

    const selectQuery = `
      SELECT n.id, n.user_id, n.title, n.message, n.channel, n.retry_count, n.payload, u.email, u.phone_number
      FROM notifications n
      INNER JOIN users u ON u.id = n.user_id
      WHERE n.status = 'PENDING' AND n.retry_count < $1
      ORDER BY n.created_at ASC LIMIT $2;
    `;

    const { rows: pendingNotifications } = await query(selectQuery, [maxRetries, batchSize]);

    let delivered = 0;
    let failed = 0;

    for (const notif of pendingNotifications) {
      try {
        let dispatchSuccess = false;

        switch (notif.channel) {
          case 'IN_APP':
            dispatchSuccess = true;
            break;
          case 'SMS':
            dispatchSuccess = await this.dispatchSms(notif);
            break;
          case 'EMAIL':
            dispatchSuccess = await this.dispatchEmail(notif);
            break;
          case 'PUSH':
            dispatchSuccess = true;
            break;
          default:
            dispatchSuccess = true;
        }

        if (dispatchSuccess) {
          await query(
            `UPDATE notifications SET status = 'SENT', sent_at = NOW() AT TIME ZONE 'UTC', updated_at = NOW() AT TIME ZONE 'UTC' WHERE id = $1;`,
            [notif.id]
          );
          delivered += 1;
        } else {
          throw new Error('Falha no despacho do canal.');
        }
      } catch (err) {
        const nextRetry = notif.retry_count + 1;
        const newStatus = nextRetry >= maxRetries ? 'FAILED' : 'PENDING';

        await query(
          `UPDATE notifications SET status = $1, retry_count = $2, failure_reason = $3, updated_at = NOW() AT TIME ZONE 'UTC' WHERE id = $4;`,
          [newStatus, nextRetry, err.message.slice(0, 255), notif.id]
        );
        failed += 1;
        this.logger.error(`[NOTIFICATIONS:JOB:FAILED] Falha ao enviar notificação [${notif.id}] via [${notif.channel}]: ${err.message}`);
      }
    }

    return { processed: pendingNotifications.length, delivered, failed };
  }

  /**
   * Envia SMS através do gateway integrado.
   */
  async dispatchSms(notif) {
    const { sms } = notificationsConfig.channels;
    if (!sms.enabled || !sms.gatewayUrl || !notif.phone_number) return true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), sms.timeoutMs || 8000);

    try {
      const response = await fetch(sms.gatewayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sms.apiKey}` },
        body: JSON.stringify({ sender_id: sms.senderId, recipient: notif.phone_number, message: `${notif.title}: ${notif.message}` }),
        signal: controller.signal
      });
      return response.ok;
    } catch (smsError) {
      this.logger.error(`[NOTIFICATIONS:SMS:ERROR] Falha de envio para [${notif.phone_number}]: ${smsError.message}`);
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Constrói o template HTML do e-mail com design ultra elegante.
   * Baseado no layout moderno de newsletters premium.
   */
  buildEmailTemplate(title, message, code = null, actionUrl = null) {
    const primaryColor = '#7c3aed'; // Roxo OneKixikila
    const bgColor = '#f4f6f9';
    const cardBg = '#ffffff';
    const textColor = '#1e293b';
    const mutedColor = '#64748b';
    
    // Fallback para imagens caso o cliente de e-mail bloqueie
    const logoUrl = 'https://onekixikila.onrender.com/assets/images/logo-email.png'; 

    return `
      <!DOCTYPE html>
      <html lang="pt-AO">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <style>
          /* Reset básico para clientes de email */
          body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
          table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
          img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
          body { margin: 0; padding: 0; width: 100% !important; background-color: ${bgColor}; }
        </style>
      </head>
      <body style="margin: 0; padding: 0; background-color: ${bgColor}; font-family: 'Inter', Helvetica, Arial, sans-serif;">
        
        <!-- Wrapper Principal -->
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${bgColor}; padding: 40px 0;">
          <tr>
            <td align="center">
              
              <!-- Container Central (Card) -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: ${cardBg}; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.04);">
                
                <!-- Cabeçalho / Logo -->
                <tr>
                  <td align="center" style="padding: 40px 20px 20px 20px;">
                    <!-- Se tiveres um logo, descomenta a imagem abaixo -->
                    <!-- <img src="${logoUrl}" alt="OneKixikila" width="140" style="display: block; max-width: 140px;" /> -->
                    <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: ${primaryColor}; letter-spacing: -0.5px;">OneKixikila</h1>
                  </td>
                </tr>

                <!-- Ícone de Destaque (Envelope) -->
                <tr>
                  <td align="center" style="padding: 20px;">
                    <div style="width: 120px; height: 120px; background-color: #f8fafc; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto;">
                      <!-- SVG inline como fallback seguro -->
                      <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="${primaryColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                        <path d="M22 7L12 13L2 7"></path>
                      </svg>
                    </div>
                  </td>
                </tr>

                <!-- Barra Divisória -->
                <tr>
                  <td align="center" style="padding: 10px 20px;">
                    <div style="width: 60px; height: 4px; background-color: ${primaryColor}; border-radius: 2px; margin: 0 auto;"></div>
                  </td>
                </tr>

                <!-- Título Principal -->
                <tr>
                  <td align="center" style="padding: 20px 30px 10px 30px;">
                    <h2 style="margin: 0; font-size: 28px; font-weight: 700; color: ${textColor}; letter-spacing: -0.5px;">
                      ${title}
                    </h2>
                  </td>
                </tr>

                <!-- Corpo do Texto -->
                <tr>
                  <td align="center" style="padding: 10px 40px 30px 40px;">
                    <p style="margin: 0; font-size: 16px; line-height: 1.6; color: ${mutedColor}; text-align: center;">
                      ${message}
                    </p>
                  </td>
                </tr>

                <!-- Código OTP (se existir) -->
                ${code ? `
                <tr>
                  <td align="center" style="padding: 0 40px 30px 40px;">
                    <div style="background-color: #f8fafc; border: 2px dashed ${primaryColor}; border-radius: 12px; padding: 20px; display: inline-block;">
                      <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: ${primaryColor}; font-family: monospace;">
                        ${code}
                      </span>
                    </div>
                  </td>
                </tr>
                ` : ''}

                <!-- Botão de Ação (se existir) -->
                ${actionUrl ? `
                <tr>
                  <td align="center" style="padding: 0 40px 40px 40px;">
                    <a href="${actionUrl}" target="_blank" style="display: inline-block; background-color: ${primaryColor}; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; padding: 14px 32px; border-radius: 9999px; box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);">
                      Confirmar E-mail
                    </a>
                  </td>
                </tr>
                ` : ''}

                <!-- Rodapé -->
                <tr>
                  <td align="center" style="padding: 30px; background-color: #f8fafc; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0 0 10px 0; font-size: 13px; color: ${mutedColor}; text-align: center;">
                      Este e-mail foi enviado pela equipa OneKixikila. Se não solicitou esta ação, por favor ignore este e-mail.
                    </p>
                    <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center;">
                      &copy; ${new Date().getFullYear()} OneKixikila — Plataforma de Kixikila Digital para Angola.
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }

  /**
   * Envia e-mail institucional via transporte SMTP configurado (cPanel).
   */
  async dispatchEmail(notif) {
    const { email } = notificationsConfig.channels;

    if (!email.enabled || !notif.email) return true;
    if (!this.emailTransporter) {
      this.logger.warn('[NOTIFICATIONS:EMAIL:WARN] Transportador SMTP não inicializado.');
      return false;
    }

    try {
      let otpCode = null;
      let actionUrl = null;

      // Tenta extrair o código OTP do payload (se existir)
      if (notif.payload && typeof notif.payload === 'object') {
        const payload = typeof notif.payload === 'string' ? JSON.parse(notif.payload) : notif.payload;
        otpCode = payload.otpCode || payload.code || payload.otp || null;
      }

      // Se o título indicar verificação, cria URL de ação (opcional)
      if (notif.title.toLowerCase().includes('verifica') || notif.title.toLowerCase().includes('código')) {
        actionUrl = 'https://onekixikila.onrender.com/verify-account';
      }

      // Constrói o HTML bonito
      const htmlBody = this.buildEmailTemplate(notif.title, notif.message, otpCode, actionUrl);

      const info = await this.emailTransporter.sendMail({
        from: email.from,
        to: notif.email,
        subject: notif.title,
        text: notif.message, // Fallback para clientes de e-mail antigos
        html: htmlBody
      });

      this.logger.info(`[NOTIFICATIONS:EMAIL:SENT] E-mail enviado para [${notif.email}] - MessageID: ${info.messageId}`);
      return true;
    } catch (emailError) {
      this.logger.error(`[NOTIFICATIONS:EMAIL:ERROR] Falha de envio para [${notif.email}]: ${emailError.message}`);
      return false;
    }
  }
}

// Instância singleton do job
const notificationsJob = new NotificationsJob();

module.exports = notificationsJob;
