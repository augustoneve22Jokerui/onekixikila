const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, MEMBERSHIP_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');
const storageConfig = require('../../config/storage');

// Limite obrigatório e inegociável de 5 MB para documentos (5.242.880 bytes)
const DOCUMENT_MAX_BYTES = limitsConfig.uploads.maxDocumentSizeBytes || 5242880;

// Categorias segregadas de documentos com políticas de acesso distintas
const DOCUMENT_CATEGORIES = Object.freeze({
  IDENTITY: 'IDENTITY',                 // Bilhetes de Identidade, passaportes e fotos faciais (estritamente confidencial)
  GROUP_ATTACHMENT: 'GROUP_ATTACHMENT', // Documentos e ficheiros partilhados no seio de grupos de Kixikila
  PAYMENT_RECEIPT: 'PAYMENT_RECEIPT',   // Comprovativos e recibos de movimentações financeiras
  PUBLIC_ASSET: 'PUBLIC_ASSET'          // Regulamentos gerais e termos institucionais públicos
});

// Papéis com autorização de auditoria e conformidade sobre documentos sensíveis
const SENSITIVE_DOC_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

/**
 * Políticas de autorização, integridade física de ficheiros e segregação estrita
 * de documentos privados na plataforma OneKixikila.
 */
class DocumentsPolicy {
  /**
   * Avalia a conformidade física do tamanho do ficheiro respeitando o teto inegociável de 5 MB.
   *
   * @param {number} fileSizeBytes - Tamanho em bytes
   * @param {string} [category='GROUP_ATTACHMENT'] - Categoria do documento
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateFileSize(fileSizeBytes, category = DOCUMENT_CATEGORIES.GROUP_ATTACHMENT) {
    const size = Number(fileSizeBytes) || 0;

    if (size <= 0) {
      return { valid: false, reason: 'Ficheiro corrompido ou vazio (0 bytes).' };
    }

    // Regra estrita: qualquer documento acima de 5.242.880 bytes deve ser rejeitado no backend
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
   * Avalia se o tipo MIME do ficheiro pertence à lista branca da categoria pretendida.
   *
   * @param {string} mimeType - Tipo MIME fornecido/inspecionado
   * @param {string} category - Categoria do documento
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateMimeType(mimeType, category = DOCUMENT_CATEGORIES.GROUP_ATTACHMENT) {
    if (!mimeType || typeof mimeType !== 'string') {
      return { valid: false, reason: 'Tipo de conteúdo (MIME Type) não identificado.' };
    }

    const normalizedMime = mimeType.toLowerCase().trim();
    let allowedList = storageConfig.allowedMimeTypes.documents;

    if (category === DOCUMENT_CATEGORIES.IDENTITY) {
      allowedList = [...storageConfig.allowedMimeTypes.images, 'application/pdf'];
    }

    if (!allowedList.includes(normalizedMime)) {
      return {
        valid: false,
        reason: `Tipo de ficheiro [${mimeType}] não autorizado para esta categoria. Formatos aceites: ${allowedList.join(', ')}.`
      };
    }

    return { valid: true };
  }

  /**
   * Avalia se um utilizador pode consultar ou descarregar determinado documento privado (Anti-IDOR/BOLA).
   * Aplica segregação estrita: a pertença a um grupo NUNCA concede autorização para visualizar
   * os documentos de identidade de outro participante.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} documentRecord - Ficha de metadados do documento
   * @param {object} [accessContext={}] - { isGroupMember, isGroupLeader }
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canViewDocument(actingUser, documentRecord, accessContext = {}) {
    if (!actingUser || !documentRecord) {
      return { allowed: false, reason: 'Utilizador ou documento não identificado.' };
    }

    // Administradores gerais possuem poder de auditoria justificada
    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    // Caso A: Documento de Identidade / KYC (Estritamente confidencial)
    if (documentRecord.category === DOCUMENT_CATEGORIES.IDENTITY || documentRecord.verification_id) {
      // Apenas o próprio titular ou auditores de conformidade possuem acesso
      if (actingUser.id === documentRecord.user_id) {
        return { allowed: true };
      }
      if (SENSITIVE_DOC_ROLES.has(actingUser.role)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'Acesso negado: Documentos de identificação oficial são confidenciais e restritos ao titular e auditores.'
      };
    }

    // Caso B: Documento de Grupo ou Anexo de Comunicação
    if (documentRecord.category === DOCUMENT_CATEGORIES.GROUP_ATTACHMENT || documentRecord.group_id) {
      const isOwner = actingUser.id === documentRecord.user_id || actingUser.id === documentRecord.uploader_id;
      if (isOwner) {
        return { allowed: true };
      }
      if (accessContext.isGroupLeader || accessContext.isGroupMember) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'Acesso negado: O documento pertence a um grupo no qual não detém filiação ativa.'
      };
    }

    // Caso C: Recibos e Comprovativos Financeiros
    if (documentRecord.category === DOCUMENT_CATEGORIES.PAYMENT_RECEIPT) {
      const isOwner = actingUser.id === documentRecord.user_id;
      if (isOwner || SENSITIVE_DOC_ROLES.has(actingUser.role)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'Acesso negado: Comprovativos financeiros são restritos às partes envolvidas.'
      };
    }

    // Caso D: Recursos públicos classificados
    if (documentRecord.category === DOCUMENT_CATEGORIES.PUBLIC_ASSET) {
      return { allowed: true };
    }

    return { allowed: false, reason: 'Política de acesso não satisfeita para este documento.' };
  }

  /**
   * Avalia se um utilizador pode eliminar fisicamente ou desvincular um documento.
   *
   * @param {object} actingUser
   * @param {object} documentRecord
   * @param {boolean} [isGroupLeader=false]
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canDeleteDocument(actingUser, documentRecord, isGroupLeader = false) {
    if (!actingUser || !documentRecord) {
      return { allowed: false, reason: 'Utilizador ou documento não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    // Documentos de identidade vinculados a processos concluídos não podem ser excluídos pelo utilizador
    if (documentRecord.category === DOCUMENT_CATEGORIES.IDENTITY && documentRecord.is_verified) {
      return {
        allowed: false,
        reason: 'Documentos de identidade homologados não podem ser eliminados por imposição legal de retenção.'
      };
    }

    const isOwner = actingUser.id === documentRecord.user_id || actingUser.id === documentRecord.uploader_id;
    if (isOwner) {
      return { allowed: true };
    }

    if (isGroupLeader && documentRecord.category === DOCUMENT_CATEGORIES.GROUP_ATTACHMENT) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'Não possui autorização para eliminar este documento.'
    };
  }
}

// Instância singleton da política de documentos
const documentsPolicy = new DocumentsPolicy();

module.exports = {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_CATEGORIES,
  documentsPolicy,
  DocumentsPolicy
};