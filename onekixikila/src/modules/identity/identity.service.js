const path = require('path');
const fs = require('fs');
const identityRepository = require('./identity.repository');
const identityPolicy = require('./identity.policy');
const cryptoUtils = require('../../shared/utils/crypto');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { withTransaction } = require('../../database/transaction');
const storageConfig = require('../../config/storage');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const ConflictError = require('../../shared/errors/conflict-error');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Verificação de Identidade e Conformidade KYC
 * na plataforma OneKixikila.
 */
class IdentityService {
  /**
   * Submete um processo de verificação com documento oficial e fotografia facial.
   * Valida duplicidade, integridade de ficheiros e armazena os documentos no bucket privado 'documentos'.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} verificationData - Dados cadastrais do documento
   * @param {object} files - Ficheiros carregados via multer (idDocument, facialPhoto)
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async submitVerification(user, verificationData, files, context = {}) {
    const { idType, idNumber, fullNameOnDocument, birthDateOnDocument, expirationDate } = verificationData;

    // 1. Verifica existência de processo prévio e aplica regras de submissão
    const existing = await identityRepository.findByUserId(user.id);
    const policyResult = identityPolicy.canSubmitVerification(user, existing);
    if (!policyResult.allowed) {
      throw new ConflictError(policyResult.reason, 'KYC_SUBMISSION_BLOCKED');
    }

    // 2. Prevenção de duplicidade: impede que outro utilizador utilize o mesmo documento aprovado
    const isAlreadyApproved = await identityRepository.isIdNumberAlreadyApproved(idNumber, user.id);
    if (isAlreadyApproved) {
      throw ConflictError.duplicate('Documento de Identidade', 'id_number', idNumber);
    }

    // 3. Validação dos ficheiros obrigatórios anexados
    if (!files || !files.idDocument || files.idDocument.length === 0) {
      throw ValidationError.fieldRequired('idDocument (Frente/Verso do Documento)');
    }

    const idDocFile = files.idDocument[0];
    const facialPhotoFile = files.facialPhoto && files.facialPhoto.length > 0 ? files.facialPhoto[0] : null;

    // 4. Execução transacional atómica da submissão no PostgreSQL
    const verification = await withTransaction(async (client) => {
      // Criação do processo em identity_verifications
      const createdVerification = await identityRepository.createVerification(
        {
          userId: user.id,
          idType,
          idNumber,
          fullNameOnDocument,
          birthDateOnDocument,
          expirationDate
        },
        client
      );

      // Processamento e gravação do ficheiro do documento oficial
      await this.persistPrivateDocument(
        {
          verificationId: createdVerification.id,
          userId: user.id,
          documentType: idType,
          file: idDocFile
        },
        client
      );

      // Processamento da fotografia facial (se fornecida)
      if (facialPhotoFile) {
        await this.persistPrivateDocument(
          {
            verificationId: createdVerification.id,
            userId: user.id,
            documentType: 'FACIAL_PHOTO',
            file: facialPhotoFile
          },
          client
        );
      }

      // Emissão de evento de domínio
      eventBus.publish(
        EVENT_TYPES.IDENTITY_SUBMITTED,
        {
          userId: user.id,
          verificationId: createdVerification.id,
          idType,
          idNumber
        },
        { requestId: context.requestId }
      );

      return createdVerification;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'IDENTITY_VERIFICATION',
        resourceId: verification.id,
        metadata: {
          idType,
          hasFacialPhoto: Boolean(facialPhotoFile)
        }
      });
    }

    return {
      verificationId: verification.id,
      status: verification.status,
      submittedAt: verification.submitted_at,
      message: 'Documentos submetidos com sucesso. A sua identidade está agora em análise de conformidade.'
    };
  }

  /**
   * Persiste o ficheiro no armazenamento privado configurado (S3/Neon Object Storage ou disco local seguro)
   * e grava o metadado correspondente na tabela verification_documents.
   *
   * @param {object} params
   * @param {import('pg').PoolClient} client
   * @private
   */
  async persistPrivateDocument({ verificationId, userId, documentType, file }, client) {
    const ext = path.extname(file.originalname).toLowerCase();
    const storageKey = `kyc/${userId}/${cryptoUtils.randomHex(16)}${ext}`;
    const fileHash = cryptoUtils.calculateFileHash(file.buffer);

    // Se o armazenamento for local em contingência, grava no diretório privado
    if (storageConfig.provider === 'local-disk') {
      const targetDir = path.join(storageConfig.localUploadsDir, 'kyc', userId);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const targetPath = path.join(storageConfig.localUploadsDir, storageKey);
      fs.writeFileSync(targetPath, file.buffer);
    }

    return identityRepository.addVerificationDocument(
      {
        verificationId,
        userId,
        documentType,
        bucketName: storageConfig.buckets.documents,
        storageKey,
        originalFilename: file.originalname,
        fileSizeBytes: file.size,
        mimeType: file.mimetype,
        fileHashSha256: fileHash
      },
      client
    );
  }

  /**
   * Consulta o estado do processo de verificação do utilizador autenticado.
   *
   * @param {object} user
   * @returns {Promise<object>}
   */
  async getMyVerification(user) {
    const verification = await identityRepository.findByUserId(user.id);
    if (!verification) {
      return {
        status: 'PENDING',
        tier: 'TIER_1_UNVERIFIED',
        documents: [],
        message: 'Ainda não submeteu documentos para validação de identidade.'
      };
    }

    return verification;
  }

  /**
   * Consulta um processo KYC específico pelo ID com validação de permissões Anti-IDOR.
   *
   * @param {object} actingUser
   * @param {string} verificationId
   * @returns {Promise<object>}
   */
  async getVerificationById(actingUser, verificationId) {
    const verification = await identityRepository.findById(verificationId);
    if (!verification) {
      throw NotFoundError.resource('Processo de Verificação', verificationId);
    }

    if (!identityPolicy.canViewVerification(actingUser, verification.user_id)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos documentos deste processo.');
    }

    return verification;
  }

  /**
   * Emite o parecer técnico administrativo sobre a verificação KYC (Aprovação/Rejeição).
   *
   * @param {object} actingUser
   * @param {string} verificationId
   * @param {object} reviewData
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async reviewVerification(actingUser, verificationId, reviewData, context = {}) {
    const verification = await identityRepository.findById(verificationId);
    if (!verification) {
      throw NotFoundError.resource('Processo de Verificação', verificationId);
    }

    const policyCheck = identityPolicy.canReviewVerification(actingUser, verification);
    if (!policyCheck.allowed) {
      throw new AuthorizationError(policyCheck.reason);
    }

    const { status, tier = 'TIER_2_VERIFIED', rejectionReason = null, reviewNotes = null } = reviewData;

    if (!identityPolicy.isValidStatusTransition(verification.status, status)) {
      throw new ConflictError(
        `Transição de estado inválida: de [${verification.status}] para [${status}].`,
        'INVALID_KYC_TRANSITION'
      );
    }

    const updated = await withTransaction(async (client) => {
      const record = await identityRepository.updateStatus(
        {
          verificationId,
          status,
          tier: status === 'APPROVED' ? tier : 'TIER_1_UNVERIFIED',
          reviewedBy: actingUser.id,
          rejectionReason: status === 'REJECTED' ? rejectionReason : null,
          reviewNotes
        },
        client
      );

      // Se aprovado, pode conceder benefícios cadastrais ao utilizador
      if (status === 'APPROVED') {
        eventBus.publish(EVENT_TYPES.IDENTITY_APPROVED, {
          userId: verification.user_id,
          tier,
          reviewedBy: actingUser.id
        });
      } else if (status === 'REJECTED') {
        eventBus.publish(EVENT_TYPES.IDENTITY_REJECTED, {
          userId: verification.user_id,
          rejectionReason,
          reviewedBy: actingUser.id
        });
      } else if (status === 'NEEDS_REVIEW') {
        eventBus.publish(EVENT_TYPES.IDENTITY_NEEDS_REVIEW, {
          userId: verification.user_id,
          reviewNotes,
          reviewedBy: actingUser.id
        });
      }

      return record;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'KYC_REVIEW',
        resourceType: 'IDENTITY_VERIFICATION',
        resourceId: verificationId,
        oldValues: { status: verification.status, tier: verification.tier },
        newValues: { status, tier, rejectionReason, reviewNotes },
        metadata: { reviewedBy: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Obtém os metadados de um ficheiro de documento privado para download autorizado.
   *
   * @param {object} actingUser
   * @param {string} documentId
   * @returns {Promise<object>}
   */
  async getDocumentForDownload(actingUser, documentId) {
    const documentRecord = await identityRepository.findDocumentById(documentId);
    if (!documentRecord) {
      throw NotFoundError.document(documentId);
    }

    if (!identityPolicy.canDownloadDocument(actingUser, documentRecord)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado para descarregar este documento confidencial.');
    }

    return documentRecord;
  }

  /**
   * Lista a fila de processos de conformidade KYC com filtros e paginação para auditores.
   *
   * @param {object} actingUser
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listVerifications(actingUser, filters, paginationParams) {
    if (!identityPolicy.canReviewVerification(actingUser, { user_id: 'check-permission-only' })) {
      throw AuthorizationError.insufficientPermissions(actingUser.role, ['ADMIN', 'AUDITOR']);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await identityRepository.listVerifications(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de identidade
const identityService = new IdentityService();

module.exports = identityService;