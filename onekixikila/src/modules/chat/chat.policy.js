const { USER_ROLES } = require('../../shared/constants/roles');
const { MEMBERSHIP_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

// Limites estritos de ficheiros no chat
const DOCUMENT_MAX_BYTES = limitsConfig.uploads.maxDocumentSizeBytes || 5242880; // 5 MB (5.242.880 bytes)
const AUDIO_MAX_BYTES = limitsConfig.uploads.maxAudioSizeBytes || 10485760;       // 10 MB (10.485.760 bytes)
const MAX_AUDIO_DURATION_SECONDS = limitsConfig.uploads.maxAudioDurationSeconds || 120; // 2 minutos

// Papéis com autorização de moderação comunitária no ecossistema
const CHAT_MODERATION_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.MODERATOR
]);

/**
 * Políticas de autorização, controlo de acesso e validação de salvaguardas
 * para a comunicação privada (texto, áudio e documentos) nos Grupos de Kixikila.
 */
class ChatPolicy {
  /**
   * Avalia se um utilizador possui autorização para aceder à sala de conversação do grupo e consultar o histórico.
   * Exige filiação ativa no grupo correspondente ou papel administrativo com finalidade de auditoria.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados do grupo
   * @param {object|null} membership - Registo de filiação em group_memberships
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canAccessChat(actingUser, group, membership = null) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN || actingUser.role === USER_ROLES.AUDITOR) {
      return { allowed: true };
    }

    if (group.status === GROUP_STATUSES.CANCELLED) {
      return { allowed: false, reason: 'A sala de chat encontra-se indisponível porque o grupo foi cancelado.' };
    }

    const isGroupLeader = actingUser.id === group.leader_id || actingUser.id === group.creator_id;

    if (!isGroupLeader && (!membership || membership.status !== MEMBERSHIP_STATUSES.ACTIVE)) {
      return {
        allowed: false,
        reason: 'O acesso à comunicação privada é restrito aos participantes com filiação ativa neste grupo de Kixikila.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o participante pode enviar mensagens (texto, áudio ou documentos) no grupo.
   * Verifica se o membro não está sob penalização de silenciamento ou bloqueio cautelar de chat (`is_banned_from_chat`).
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object|null} membership
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canSendMessage(actingUser, group, membership = null) {
    const accessCheck = this.canAccessChat(actingUser, group, membership);
    if (!accessCheck.allowed) {
      return accessCheck;
    }

    if (membership && membership.is_banned_from_chat) {
      return {
        allowed: false,
        reason: 'A sua conta encontra-se temporariamente silenciada pela liderança do grupo por violação das regras comunitárias.'
      };
    }

    if (group.status === GROUP_STATUSES.PAUSED) {
      return {
        allowed: false,
        reason: 'O grupo encontra-se em pausa temporária. O envio de novas mensagens está suspenso.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia a conformidade de upload de anexos de documentos respeitando o limite físico inegociável de 5 MB.
   *
   * @param {number} fileSizeBytes - Tamanho do ficheiro em bytes
   * @param {string} mimeType - Tipo MIME do documento
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateDocumentAttachment(fileSizeBytes, mimeType) {
    const size = Number(fileSizeBytes) || 0;

    if (size <= 0) {
      return { valid: false, reason: 'Ficheiro corrompido ou vazio (0 bytes).' };
    }

    if (size > DOCUMENT_MAX_BYTES) {
      const maxMb = (DOCUMENT_MAX_BYTES / (1024 * 1024)).toFixed(0);
      return {
        valid: false,
        reason: `O documento excede o limite máximo permitido de ${maxMb} MB (${DOCUMENT_MAX_BYTES} bytes). Tamanho enviado: ${(size / (1024 * 1024)).toFixed(2)} MB.`
      };
    }

    return { valid: true };
  }

  /**
   * Avalia a conformidade de upload de notas de voz/áudio respeitando o limite de 10 MB e duração máxima de 120s.
   *
   * @param {number} fileSizeBytes
   * @param {number|null} [durationSeconds=null]
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateAudioAttachment(fileSizeBytes, durationSeconds = null) {
    const size = Number(fileSizeBytes) || 0;

    if (size <= 0) {
      return { valid: false, reason: 'Ficheiro de áudio vazio ou corrompido.' };
    }

    if (size > AUDIO_MAX_BYTES) {
      return {
        valid: false,
        reason: `A mensagem de áudio excede o limite de ${AUDIO_MAX_BYTES / (1024 * 1024)} MB (${AUDIO_MAX_BYTES} bytes).`
      };
    }

    if (durationSeconds !== null && durationSeconds !== undefined) {
      const duration = Number(durationSeconds);
      if (duration > MAX_AUDIO_DURATION_SECONDS) {
        return {
          valid: false,
          reason: `A duração da gravação excede o limite máximo autorizado de ${MAX_AUDIO_DURATION_SECONDS} segundos (2 minutos).`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Avalia se um utilizador pode eliminar uma mensagem do histórico.
   * O próprio remetente pode eliminar mensagens enviadas; o Líder do grupo, Moderador ou Admin podem censurar qualquer mensagem.
   *
   * @param {object} actingUser
   * @param {object} message - Registo da tabela chat_messages
   * @param {boolean} [isGroupLeader=false]
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canDeleteMessage(actingUser, message, isGroupLeader = false) {
    if (!actingUser || !message) {
      return { allowed: false, reason: 'Utilizador ou mensagem não identificada.' };
    }

    if (message.is_deleted) {
      return { allowed: false, reason: 'Esta mensagem já se encontra eliminada.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN || CHAT_MODERATION_ROLES.has(actingUser.role)) {
      return { allowed: true };
    }

    if (isGroupLeader) {
      return { allowed: true };
    }

    if (actingUser.id === message.sender_id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'Não possui autorização para remover mensagens de outro participante.'
    };
  }

  /**
   * Avalia se o participante pode fixar/desafixar uma mensagem importante no topo da sala.
   * Ação estritamente reservada à liderança do grupo ou a administradores.
   *
   * @param {object} actingUser
   * @param {boolean} [isGroupLeader=false]
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canPinMessage(actingUser, isGroupLeader = false) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN || isGroupLeader) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'A fixação de avisos no topo do grupo é reservada à liderança.'
    };
  }

  /**
   * Avalia se o participante pode submeter uma denúncia formal contra uma mensagem abusiva.
   *
   * @param {object} actingUser
   * @param {object} message
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canReportMessage(actingUser, message) {
    if (!actingUser || !message) {
      return { allowed: false, reason: 'Parâmetros insuficientes para denúncia.' };
    }

    if (actingUser.id === message.sender_id) {
      return { allowed: false, reason: 'Não é permitido denunciar as suas próprias mensagens.' };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode deliberar e agir sobre uma denúncia comunitária.
   *
   * @param {object} actingUser
   * @param {boolean} [isGroupLeader=false]
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canModerateReport(actingUser, isGroupLeader = false) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN || CHAT_MODERATION_ROLES.has(actingUser.role) || isGroupLeader) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'A moderação de denúncias exige privilégios de liderança do grupo ou moderação da plataforma.'
    };
  }
}

// Instância singleton da política de chat
const chatPolicy = new ChatPolicy();

module.exports = {
  DOCUMENT_MAX_BYTES,
  AUDIO_MAX_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  chatPolicy,
  ChatPolicy
};