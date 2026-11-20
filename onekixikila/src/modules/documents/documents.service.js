const path = require('path');
const fs = require('fs');
const documentsRepository = require('./documents.repository');
const { documentsPolicy, DOCUMENT_CATEGORIES } = require('./documents.policy');
const fileInspectionService = require('./file-inspection.service');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const storageConfig = require('../../config/storage');
const storageProvider = require('../storage/storage-provider');
const cryptoUtils = require('../../shared/utils/crypto');
const { sanitizeFileName } = require('../../shared/security/sanitize');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Gestão, Inspeção e Armazenamento Privado
 * de Documentos na plataforma OneKixikila.
 * Impõe a barreira física de 5 MB (5.242.880 bytes), garante segregação confidencial
 * entre ficheiros de identificação e anexos comunitários, e viabiliza downloads auditados.
 */
class DocumentsService {
  /**
   * Processa o upload de um documento privado ou avatar de perfil.
   * Executa inspeção profunda de bytes (Magic Numbers), validação de tamanho (<= 5 MB),
   * bloqueio de executáveis disfarçados e armazenamento garantido.
   *
   * Categorias suportadas:
   * - IDENTITY          → verification_documents (KYC)
   * - GROUP_ATTACHMENT  → chat_attachments (anexos comunitários)
   * - AVATAR            → atualiza user_profiles.avatar_url (imagem pública do perfil)
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} documentData - Metadados { category, description, groupId, targetUserId }
   * @param {object} file - Ficheiro multipart ({ originalname, buffer, size, mimetype })
   * @param {object} [context={}] - Contexto de rastreamento e auditoria
   * @returns {Promise<object>} Ficha do documento criado
   */
  async uploadDocument(actingUser, documentData, file, context = {}) {
    if (!file || !file.buffer) {
      throw ValidationError.fieldRequired('document (conteúdo do ficheiro)');
    }

    const {
      category = DOCUMENT_CATEGORIES.GROUP_ATTACHMENT,
      groupId = null,
      description = null
    } = documentData;

    // 1. Inspeção profunda de integridade física no buffer (<= 5 MB e deteção de executáveis)
    const inspection = fileInspectionService.assertSafeFile(file, category);

    // 2. Se vinculado a um grupo, valida a filiação ativa (AVATAR é pessoal — não exige grupo)
    if (groupId && category !== 'AVATAR') {
      const group = await groupsRepository.findById(groupId);
      if (!group) {
        throw NotFoundError.group(groupId);
      }

      const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
      const isLeader = group.leader_id === actingUser.id || group.creator_id === actingUser.id;
      const isActiveMember = Boolean(membership && membership.status === 'ACTIVE');

      if (!isLeader && !isActiveMember && actingUser.role !== 'ADMIN') {
        throw AuthorizationError.forbiddenResource(
          'Apenas membros com filiação ativa podem partilhar ficheiros neste grupo.'
        );
      }
    }

    // 3. Sanitização de nome e geração de chave opaca de armazenamento
    const safeOriginalName = sanitizeFileName(file.originalname || `doc_${Date.now()}`);
    const extension = path.extname(safeOriginalName).toLowerCase() || '.bin';
    const uniqueKey = cryptoUtils.randomHex(16);

    // --------------------------------------------------------------------------
    // 3a. CATEGORIA AVATAR: Imagem de perfil do utilizador
    // --------------------------------------------------------------------------
    if (category === 'AVATAR') {
      const avatarStorageKey = `avatars/${actingUser.id}/${uniqueKey}${extension}`;

      // Gravação física no disco local garantida (para que o express.static sirva /uploads/avatars/...)
      const avatarDir = path.join(storageConfig.localUploadsDir, 'avatars', actingUser.id);
      if (!fs.existsSync(avatarDir)) {
        fs.mkdirSync(avatarDir, { recursive: true });
      }
      const avatarFilePath = path.join(storageConfig.localUploadsDir, avatarStorageKey);
      fs.writeFileSync(avatarFilePath, file.buffer);

      // Se configurado S3 com credenciais reais (não de exemplo), envia também para o bucket S3
      if (
        storageConfig.provider === 's3-compatible' &&
        storageConfig.s3.credentials.accessKeyId &&
        !storageConfig.s3.credentials.accessKeyId.includes('exemplo')
      ) {
        try {
          await storageProvider.putObject(
            storageConfig.buckets.assets,
            avatarStorageKey,
            file.buffer,
            inspection.detectedMimeType
          );
        } catch (s3Error) {
          console.warn('[DOCUMENTS:AVATAR:S3_WARN] Falha ao enviar para S3, mantendo cópia local:', s3Error.message);
        }
      }

      // Caminho público servido pela aplicação (express.static em /uploads)
      const publicPath = `/uploads/${avatarStorageKey}`;

      // Atualização atómica do perfil na base de dados
      const { queryOne } = require('../../database/query');
      const updatedProfile = await queryOne(
        `UPDATE user_profiles
            SET avatar_url = $1,
                updated_at = NOW() AT TIME ZONE 'UTC'
          WHERE user_id = $2
          RETURNING user_id, avatar_url, updated_at;`,
        [publicPath, actingUser.id]
      );

      if (!updatedProfile) {
        if (fs.existsSync(avatarFilePath)) {
          try {
            fs.unlinkSync(avatarFilePath);
          } catch (err) {
            console.error(`[DOCUMENTS:AVATAR:ROLLBACK] Falha ao remover ficheiro órfão [${avatarFilePath}]:`, err.message);
          }
        }
        throw NotFoundError.user ? NotFoundError.user(actingUser.id) : new NotFoundError('Perfil de utilizador não encontrado.');
      }

      if (context.recordAudit) {
        await context.recordAudit({
          action: 'UPDATE',
          resourceType: 'USER_AVATAR',
          resourceId: actingUser.id,
          newValues: { avatarUrl: publicPath },
          metadata: {
            originalFilename: safeOriginalName,
            fileSizeBytes: inspection.fileSizeBytes,
            mimeType: inspection.detectedMimeType,
            fileHashSha256: inspection.fileHashSha256
          }
        });
      }

      return {
        id: null,
        category: 'AVATAR',
        avatarUrl: publicPath,
        originalFilename: safeOriginalName,
        fileSizeBytes: inspection.fileSizeBytes,
        mimeType: inspection.detectedMimeType,
        fileHashSha256: inspection.fileHashSha256,
        createdAt: updatedProfile.updated_at,
        message: 'Foto de perfil atualizada com sucesso.'
      };
    }

    // --------------------------------------------------------------------------
    // 3b. CATEGORIAS DE DOCUMENTOS CONFIDENCIAIS (Cofre Privado)
    // --------------------------------------------------------------------------
    const storageKey = `documents/${category.toLowerCase()}/${actingUser.id}/${uniqueKey}${extension}`;

    // Gravação física local garantida
    const targetDir = path.join(storageConfig.localUploadsDir, 'documents', category.toLowerCase(), actingUser.id);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const targetFilePath = path.join(storageConfig.localUploadsDir, storageKey);
    fs.writeFileSync(targetFilePath, file.buffer);

    // Se S3 estiver configurado com credenciais válidas, envia para o bucket privado
    if (
      storageConfig.provider === 's3-compatible' &&
      storageConfig.s3.credentials.accessKeyId &&
      !storageConfig.s3.credentials.accessKeyId.includes('exemplo')
    ) {
      try {
        await storageProvider.putObject(
          storageConfig.buckets.documents,
          storageKey,
          file.buffer,
          inspection.detectedMimeType
        );
      } catch (s3DocError) {
        console.warn('[DOCUMENTS:S3_WARN] Falha ao enviar para S3 privado, mantendo cópia local:', s3DocError.message);
      }
    }

    // 5. Registo na base de dados
    let createdRecord;
    if (category === DOCUMENT_CATEGORIES.IDENTITY) {
      const { queryOne } = require('../../database/query');
      const text = `
        INSERT INTO verification_documents (
          verification_id,
          user_id,
          document_type,
          bucket_name,
          storage_key,
          original_filename,
          file_size_bytes,
          mime_type,
          file_hash_sha256
        )
        VALUES (
          gen_random_uuid(),
          $1,
          'NATIONAL_ID',
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING *;
      `;
      createdRecord = await queryOne(text, [
        actingUser.id,
        storageConfig.buckets.documents,
        storageKey,
        safeOriginalName,
        inspection.fileSizeBytes,
        inspection.detectedMimeType,
        inspection.fileHashSha256
      ]);
    } else {
      const { queryOne } = require('../../database/query');
      const text = `
        INSERT INTO chat_attachments (
          message_id,
          group_id,
          uploader_id,
          attachment_type,
          bucket_name,
          storage_key,
          original_filename,
          file_size_bytes,
          mime_type,
          file_hash_sha256
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          'DOCUMENT',
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
        RETURNING *;
      `;
      createdRecord = await queryOne(text, [
        groupId,
        actingUser.id,
        storageConfig.buckets.documents,
        storageKey,
        safeOriginalName,
        inspection.fileSizeBytes,
        inspection.detectedMimeType,
        inspection.fileHashSha256
      ]);
    }

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'DOCUMENT',
        resourceId: createdRecord.id,
        metadata: {
          category,
          originalFilename: safeOriginalName,
          fileSizeBytes: inspection.fileSizeBytes,
          mimeType: inspection.detectedMimeType
        }
      });
    }

    return {
      id: createdRecord.id,
      category,
      originalFilename: safeOriginalName,
      fileSizeBytes: inspection.fileSizeBytes,
      mimeType: inspection.detectedMimeType,
      fileHashSha256: inspection.fileHashSha256,
      createdAt: createdRecord.created_at,
      message: 'Documento enviado e armazenado com sucesso no cofre privado.'
    };
  }

  /**
   * Obtém os metadados e autoriza o descarregamento de um documento confidencial (Anti-IDOR).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} documentId - UUID do documento
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async getDocumentForDownload(actingUser, documentId, context = {}) {
    const documentRecord = await documentsRepository.findDocumentById(documentId);
    if (!documentRecord) {
      throw NotFoundError.document(documentId);
    }

    let isGroupMember = false;
    let isGroupLeader = false;

    if (documentRecord.group_id) {
      const group = await groupsRepository.findById(documentRecord.group_id);
      if (group) {
        isGroupLeader = actingUser.id === group.leader_id || actingUser.id === group.creator_id;
        const membership = await membershipsRepository.findByGroupAndUser(group.id, actingUser.id);
        isGroupMember = Boolean(membership && membership.status === 'ACTIVE');
      }
    }

    const accessCheck = documentsPolicy.canViewDocument(actingUser, documentRecord, {
      isGroupMember,
      isGroupLeader
    });

    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'EXPORT_DATA',
        resourceType: 'DOCUMENT',
        resourceId: documentId,
        metadata: {
          category: documentRecord.category,
          originalFilename: documentRecord.original_filename,
          ownerUserId: documentRecord.user_id
        }
      });
    }

    return documentRecord;
  }

  /**
   * Homologa ou rejeita a conformidade de um documento de identificação (Ação de Auditoria/Admin).
   *
   * @param {object} actingUser - Auditor ou Administrador
   * @param {string} documentId - UUID do documento
   * @param {object} reviewData - { isVerified, reviewNotes }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async verifyDocument(actingUser, documentId, reviewData, context = {}) {
    if (actingUser.role !== 'ADMIN' && actingUser.role !== 'AUDITOR') {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR'
      ]);
    }

    const documentRecord = await documentsRepository.findDocumentById(documentId);
    if (!documentRecord) {
      throw NotFoundError.document(documentId);
    }

    if (documentRecord.category !== DOCUMENT_CATEGORIES.IDENTITY) {
      throw new ConflictError('Apenas documentos de identificação oficial comportam homologação formal.');
    }

    const { isVerified, reviewNotes = null } = reviewData;
    const updated = await documentsRepository.updateVerificationDocumentStatus(documentId, Boolean(isVerified));

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'KYC_REVIEW',
        resourceType: 'VERIFICATION_DOCUMENT',
        resourceId: documentId,
        oldValues: { isVerified: documentRecord.is_verified },
        newValues: { isVerified: Boolean(isVerified), reviewNotes, verifiedBy: actingUser.id }
      });
    }

    return {
      message: `Documento ${isVerified ? 'validado' : 'invalidado'} com sucesso.`,
      document: updated
    };
  }

  /**
   * Elimina um documento do armazenamento e da base de dados com validação de permissões.
   *
   * @param {object} actingUser
   * @param {string} documentId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async deleteDocument(actingUser, documentId, context = {}) {
    const documentRecord = await documentsRepository.findDocumentById(documentId);
    if (!documentRecord) {
      throw NotFoundError.document(documentId);
    }

    let isGroupLeader = false;
    if (documentRecord.group_id) {
      const group = await groupsRepository.findById(documentRecord.group_id);
      isGroupLeader = group && (group.leader_id === actingUser.id || group.creator_id === actingUser.id);
    }

    const deleteCheck = documentsPolicy.canDeleteDocument(actingUser, documentRecord, isGroupLeader);
    if (!deleteCheck.allowed) {
      throw new AuthorizationError(deleteCheck.reason);
    }

    // Remoção física em disco local se aplicável
    if (documentRecord.storage_key) {
      const filePath = path.join(storageConfig.localUploadsDir, documentRecord.storage_key);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`[DOCUMENTS:DELETE:WARN] Falha ao apagar ficheiro físico [${filePath}]:`, err.message);
        }
      }
    }

    await documentsRepository.deleteDocumentRecord(documentId, documentRecord.category);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'DOCUMENT',
        resourceId: documentId,
        metadata: {
          category: documentRecord.category,
          storageKey: documentRecord.storage_key,
          deletedBy: actingUser.id
        }
      });
    }

    return {
      message: 'Documento eliminado com sucesso.'
    };
  }

  /**
   * Lista os documentos pertencentes a um utilizador com paginação.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserDocuments(actingUser, targetUserId, filters, paginationParams) {
    if (actingUser.id !== targetUserId && actingUser.role !== 'ADMIN' && actingUser.role !== 'AUDITOR') {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos documentos deste utilizador.');
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await documentsRepository.listUserDocuments(targetUserId, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista os documentos e anexos partilhados num grupo de Kixikila.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listGroupDocuments(actingUser, groupId, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const isMember = Boolean(membership && membership.status === 'ACTIVE');
    const isLeader = group.leader_id === actingUser.id || group.creator_id === actingUser.id;

    if (!isLeader && !isMember && actingUser.role !== 'ADMIN') {
      throw AuthorizationError.forbiddenResource('Acesso restrito aos membros deste grupo.');
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await documentsRepository.listGroupDocuments(groupId, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de documentos
const documentsService = new DocumentsService();

module.exports = documentsService;