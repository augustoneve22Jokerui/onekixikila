const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, IDENTITY_STATUSES } = require('../../shared/constants/statuses');

// Papéis com permissão formal para auditar e deliberar sobre processos KYC
const KYC_REVIEW_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.AUDITOR]);

// Papéis autorizados a consultar documentos de identidade para suporte de conformidade
const KYC_VIEW_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.AUDITOR, USER_ROLES.SUPPORT_AGENT]);

/**
 * Políticas de autorização, controlo de acesso estrito e regras de transição de estado
 * para o módulo de Verificação de Identidade e Conformidade KYC da plataforma OneKixikila.
 */
class IdentityPolicy {
  /**
   * Avalia se o utilizador pode submeter um novo processo ou novos documentos de identificação.
   * Impede submissões simultâneas concorrentes caso já exista um processo em análise (`UNDER_REVIEW`)
   * ou se a identidade já estiver devidamente aprovada (`APPROVED`), salvo se exigida atualização.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object|null} existingVerification - Registo do processo atual (se houver)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canSubmitVerification(user, existingVerification = null) {
    if (!user) {
      return { allowed: false, reason: 'Autenticação necessária para envio de documentos.' };
    }

    if (user.status === USER_STATUSES.BLOCKED || user.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${user.status}]. Não é permitido submeter documentos.`
      };
    }

    if (existingVerification) {
      if (existingVerification.status === IDENTITY_STATUSES.UNDER_REVIEW) {
        return {
          allowed: false,
          reason: 'Já possui um processo de validação em análise pela nossa equipa de conformidade. Aguarde a deliberação.'
        };
      }

      if (existingVerification.status === IDENTITY_STATUSES.APPROVED) {
        return {
          allowed: false,
          reason: 'A sua identidade já se encontra verificada e aprovada na plataforma.'
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador atuante possui permissão para consultar o processo KYC (Anti-IDOR).
   * O próprio titular pode consultar o seu estado; agentes de conformidade podem auditar.
   * Outros participantes de grupos NUNCA possuem acesso a dados ou documentos de identidade de terceiros.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @returns {boolean}
   */
  canViewVerification(actingUser, targetUserId) {
    if (!actingUser) {
      return false;
    }

    // O próprio titular pode acompanhar o seu processo
    if (actingUser.id === targetUserId) {
      return true;
    }

    // Apenas funções administrativas com finalidade legítima de conformidade
    return KYC_VIEW_ROLES.has(actingUser.role);
  }

  /**
   * Avalia se o utilizador possui autorização para descarregar ou visualizar um documento privado de identidade.
   * O documento de identidade é estritamente confidencial (armazenado no bucket privado 'documentos').
   *
   * @param {object} actingUser
   * @param {object} documentRecord - Registo da tabela verification_documents
   * @returns {boolean}
   */
  canDownloadDocument(actingUser, documentRecord) {
    if (!actingUser || !documentRecord) {
      return false;
    }

    if (actingUser.id === documentRecord.user_id) {
      return true;
    }

    return KYC_REVIEW_ROLES.has(actingUser.role);
  }

  /**
   * Avalia se o utilizador pode emitir parecer técnico (aprovar, rejeitar ou solicitar revisão) sobre um processo KYC.
   * Ação estritamente reservada a Auditores e Administradores Gerais.
   *
   * @param {object} actingUser
   * @param {object} verificationRecord
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canReviewVerification(actingUser, verificationRecord) {
    if (!actingUser || !KYC_REVIEW_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A revisão e aprovação de identidades exige privilégios de AUDITOR ou ADMIN.'
      };
    }

    if (!verificationRecord) {
      return { allowed: false, reason: 'Processo de verificação não localizado.' };
    }

    // Previne que um auditor aprove o seu próprio processo de identidade
    if (actingUser.id === verificationRecord.user_id) {
      return {
        allowed: false,
        reason: 'Conflito de interesses: Um auditor não pode aprovar a sua própria verificação cadastral.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia a transição válida de estado para o parecer de conformidade.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      PENDING: ['UNDER_REVIEW', 'REJECTED'],
      UNDER_REVIEW: ['APPROVED', 'REJECTED', 'NEEDS_REVIEW'],
      NEEDS_REVIEW: ['UNDER_REVIEW', 'REJECTED'],
      REJECTED: ['UNDER_REVIEW'], // Permite nova análise após reenvio
      APPROVED: ['EXPIRED', 'NEEDS_REVIEW'],
      EXPIRED: ['UNDER_REVIEW']
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de identidade
const identityPolicy = new IdentityPolicy();

module.exports = identityPolicy;