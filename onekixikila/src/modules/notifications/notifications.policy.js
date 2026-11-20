const { USER_ROLES } = require('../../shared/constants/roles');

// Canais autorizados para envio e receção de notificações
const ALLOWED_NOTIFICATION_CHANNELS = new Set(['IN_APP', 'EMAIL', 'SMS', 'PUSH']);

// Estados válidos de notificação
const ALLOWED_NOTIFICATION_STATUSES = new Set(['PENDING', 'SENT', 'DELIVERED', 'FAILED', 'READ']);

/**
 * Políticas de autorização, integridade de entrega e privacidade (Anti-IDOR)
 * para o módulo de Notificações Multicanal da plataforma OneKixikila.
 */
class NotificationsPolicy {
  /**
   * Avalia se o utilizador atuante possui permissão para consultar ou interagir com uma notificação.
   * O próprio destinatário pode aceder; Administradores possuem autorização para auditoria de entrega.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} notification - Registo da tabela notifications
   * @returns {boolean}
   */
  canAccessNotification(actingUser, notification) {
    if (!actingUser || !notification) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    return actingUser.id === notification.user_id;
  }

  /**
   * Avalia se o utilizador pode marcar uma notificação como lida.
   * Ação estritamente reservada ao próprio destinatário da notificação.
   *
   * @param {object} actingUser
   * @param {object} notification
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canMarkAsRead(actingUser, notification) {
    if (!actingUser || !notification) {
      return { allowed: false, reason: 'Utilizador ou notificação não identificados.' };
    }

    if (actingUser.id !== notification.user_id) {
      return {
        allowed: false,
        reason: 'Não possui autorização para alterar o estado de notificações de outro utilizador.'
      };
    }

    return { allowed: true };
  }

  /**
   * Valida a integridade da estrutura de uma notificação a ser despachada.
   *
   * @param {object} notificationData
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateNotificationStructure(notificationData) {
    if (!notificationData) {
      return { valid: false, reason: 'Dados da notificação ausentes.' };
    }

    if (!notificationData.userId) {
      return { valid: false, reason: 'Identificador do utilizador destinatário (userId) é obrigatório.' };
    }

    if (!notificationData.title || typeof notificationData.title !== 'string') {
      return { valid: false, reason: 'Título da notificação é obrigatório.' };
    }

    if (!notificationData.message || typeof notificationData.message !== 'string') {
      return { valid: false, reason: 'Conteúdo da mensagem da notificação é obrigatório.' };
    }

    const channel = notificationData.channel || 'IN_APP';
    if (!ALLOWED_NOTIFICATION_CHANNELS.has(channel)) {
      return {
        valid: false,
        reason: `Canal de notificação [${channel}] inválido. Valores aceites: IN_APP, EMAIL, SMS, PUSH.`
      };
    }

    return { valid: true };
  }
}

// Instância singleton da política de notificações
const notificationsPolicy = new NotificationsPolicy();

module.exports = notificationsPolicy;