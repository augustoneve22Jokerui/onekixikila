const storageProvider = require('./storage-provider');
const storageRepository = require('./storage.repository');
const storageConfig = require('../../config/storage');
const { documentsPolicy, DOCUMENT_CATEGORIES } = require('../documents/documents.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço especializado na autorização rigorosa, auditoria e entrega segura (streaming/URL assinada)
 * de ficheiros e documentos privados e confidenciais na plataforma OneKixikila.
 * Impede a exposição pública de ficheiros de identidade KYC, comprovativos bancários e anexos de grupos,
 * validando titularidade (Anti-IDOR/BOLA) antes de disponibilizar o fluxo binário.
 */
class PrivateDownloadService {
  /**
   * Avalia a autorização de acesso ao ficheiro e retorna um fluxo de leitura (Stream)
   * juntamente com os cabeçalhos HTTP apropriados para download seguro.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} storageKey - Chave de armazenamento do objeto
   * @param {object} [context={}] - Contexto de auditoria HTTP (ipAddress, userAgent, requestId)
   * @returns {Promise<{
   *   stream: any,
   *   contentType: string,
   *   contentLength: number,
   *   originalFilename: string,
   *   bucketName: string,
   *   storageKey: string
   * }>}
   */
  async getAuthorizedFileStream(actingUser, storageKey, context = {}) {
    if (!actingUser) {
      throw AuthorizationError.forbiddenResource('Autenticação prévia obrigatória para acesso a documentos privados.');
    }

    if (!storageKey || typeof storageKey !== 'string') {
      throw ValidationError.fieldRequired('storageKey');
    }

    // 1. Localiza os metadados do documento associados à chave de armazenamento
    const fileMetadata = await storageRepository.findFileByStorageKey(storageKey);
    if (!fileMetadata) {
      throw NotFoundError.resource('Documento Privado', storageKey);
    }

    // 2. Validação estrita de autorização e titularidade
    await this.assertDownloadAuthorization(actingUser, fileMetadata);

    // 3. Registo de auditoria imutável do acesso/exportação aos dados
    await storageRepository.recordStorageAccessAudit({
      storageKey,
      bucketName: fileMetadata.bucket_name,
      userId: actingUser.id,
      action: 'EXPORT_DATA',
      ipAddress: context.ipAddress || null,
      userAgent: context.userAgent || null,
      metadata: {
        category: fileMetadata.category,
        originalFilename: fileMetadata.original_filename,
        fileSizeBytes: fileMetadata.file_size_bytes,
        requestId: context.requestId || null
      }
    });

    // 4. Obtenção do stream físico via provedor de armazenamento
    const objectData = await storageProvider.getObject(fileMetadata.bucket_name, storageKey);

    return {
      stream: objectData.stream,
      contentType: fileMetadata.mime_type || objectData.contentType || 'application/octet-stream',
      contentLength: Number(fileMetadata.file_size_bytes) || objectData.contentLength || 0,
      originalFilename: fileMetadata.original_filename || 'documento_privado.bin',
      bucketName: fileMetadata.bucket_name,
      storageKey
    };
  }

  /**
   * Avalia a autorização de acesso e gera uma URL assinada temporária (Presigned URL)
   * para descarregamento direto do bucket privado com validade limitada.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} storageKey - Chave de armazenamento do objeto
   * @param {number|null} [expiresInSeconds=null] - Tempo de validade da URL
   * @param {object} [context={}] - Contexto de auditoria
   * @returns {Promise<{
   *   signedUrl: string,
   *   expiresInSeconds: number,
   *   originalFilename: string,
   *   mimeType: string,
   *   fileSizeBytes: number
   * }>}
   */
  async getAuthorizedDownloadUrl(actingUser, storageKey, expiresInSeconds = null, context = {}) {
    if (!actingUser) {
      throw AuthorizationError.forbiddenResource('Autenticação prévia obrigatória para acesso a documentos privados.');
    }

    if (!storageKey || typeof storageKey !== 'string') {
      throw ValidationError.fieldRequired('storageKey');
    }

    const fileMetadata = await storageRepository.findFileByStorageKey(storageKey);
    if (!fileMetadata) {
      throw NotFoundError.resource('Documento Privado', storageKey);
    }

    // Validação de autorização
    await this.assertDownloadAuthorization(actingUser, fileMetadata);

    const ttl = expiresInSeconds || storageConfig.signedUrlTtl.privateDownload;
    const signedUrl = await storageProvider.getSignedDownloadUrl(fileMetadata.bucket_name, storageKey, ttl);

    // Auditoria de emissão de link temporário
    await storageRepository.recordStorageAccessAudit({
      storageKey,
      bucketName: fileMetadata.bucket_name,
      userId: actingUser.id,
      action: 'EXPORT_DATA',
      ipAddress: context.ipAddress || null,
      userAgent: context.userAgent || null,
      metadata: {
        category: fileMetadata.category,
        originalFilename: fileMetadata.original_filename,
        ttl,
        presignedUrl: true,
        requestId: context.requestId || null
      }
    });

    return {
      signedUrl,
      expiresInSeconds: ttl,
      originalFilename: fileMetadata.original_filename,
      mimeType: fileMetadata.mime_type,
      fileSizeBytes: Number(fileMetadata.file_size_bytes)
    };
  }

  /**
   * Valida as permissões de acesso com base na categoria e no vínculo do utilizador.
   * Aplica segregação estrita: pertencer a um grupo não concede acesso aos documentos de identidade de terceiros.
   *
   * @param {object} actingUser
   * @param {object} fileMetadata
   * @private
   */
  async assertDownloadAuthorization(actingUser, fileMetadata) {
    let isGroupMember = false;
    let isGroupLeader = false;

    // Se o ficheiro estiver associado a um grupo de Kixikila, verifica o vínculo do utilizador
    if (fileMetadata.group_id) {
      const group = await groupsRepository.findById(fileMetadata.group_id);
      if (group) {
        isGroupLeader = actingUser.id === group.leader_id || actingUser.id === group.creator_id;
        const membership = await membershipsRepository.findByGroupAndUser(group.id, actingUser.id);
        isGroupMember = Boolean(membership && membership.status === 'ACTIVE');
      }
    }

    const accessCheck = documentsPolicy.canViewDocument(actingUser, fileMetadata, {
      isGroupMember,
      isGroupLeader
    });

    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }
  }
}

// Instância singleton do serviço de downloads privados
const privateDownloadService = new PrivateDownloadService();

module.exports = privateDownloadService;