const path = require('path');
const storageConfig = require('../../config/storage');
const storageProvider = require('./storage-provider');
const storageRepository = require('./storage.repository');
const cryptoUtils = require('../../shared/utils/crypto');
const { sanitizeFileName } = require('../../shared/security/sanitize');
const ValidationError = require('../../shared/errors/validation-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const AuthorizationError = require('../../shared/errors/authorization-error');

/**
 * Serviço orquestrador de regras de negócio para Armazenamento de Ficheiros e Objetos (Storage).
 * Centraliza as operações de envio, obtenção, exclusão e auditoria de ficheiros nos buckets oficiais
 * ('upload', 'assets', 'documentos'), garantindo o isolamento confidencial de documentos privados,
 * geração de chaves opacas anti-traversal e integração com Neon Object Storage / S3.
 */
class StorageService {
  /**
   * Salva um ficheiro no armazenamento (Neon Object Storage ou disco local em contingência)
   * e valida os limites físicos e de tipos MIME configurados.
   *
   * @param {object} params
   * @param {string} params.bucketName - Nome do bucket de destino ('upload', 'assets', 'documentos')
   * @param {string} params.folder - Subdiretório lógico de organização (ex: 'documents/group', 'chat/audio')
   * @param {object} params.file - Objeto de ficheiro em memória ({ originalname, buffer, mimetype, size })
   * @param {object} [params.metadata={}] - Metadados adicionais
   * @param {object} [context={}] - Contexto de auditoria
   * @returns {Promise<{
   *   storageKey: string,
   *   bucketName: string,
   *   fileSizeBytes: number,
   *   mimeType: string,
   *   originalFilename: string,
   *   fileHashSha256: string
   * }>}
   */
  async storeFile(params, context = {}) {
    const { bucketName, folder, file, metadata = {} } = params;

    if (!file || !file.buffer) {
      throw ValidationError.fieldRequired('file (conteúdo do ficheiro)');
    }

    if (!bucketName) {
      throw ValidationError.fieldRequired('bucketName');
    }

    const validBuckets = Object.values(storageConfig.buckets);
    if (!validBuckets.includes(bucketName)) {
      throw new ValidationError(
        `Bucket de armazenamento [${bucketName}] inválido. Buckets válidos: ${validBuckets.join(', ')}.`
      );
    }

    const fileSizeBytes = file.size || file.buffer.length;
    if (fileSizeBytes <= 0) {
      throw new ValidationError('Ficheiro vazio ou corrompido (0 bytes).');
    }

    // Validação estrita de limites por bucket/categoria
    if (bucketName === storageConfig.buckets.documents && fileSizeBytes > storageConfig.limits.documentMaxBytes) {
      const maxMb = (storageConfig.limits.documentMaxBytes / (1024 * 1024)).toFixed(0);
      throw new ValidationError(
        `O documento excede o limite estrito permitido de ${maxMb} MB (${storageConfig.limits.documentMaxBytes} bytes).`
      );
    }

    // Higienização do nome original e geração de chave de armazenamento criptográfica opaca
    const originalFilename = sanitizeFileName(file.originalname || `file_${Date.now()}`);
    const extension = path.extname(originalFilename).toLowerCase() || '.bin';
    const randomIdentifier = cryptoUtils.randomHex(16);
    const cleanFolder = (folder || 'general').replace(/^\/+|\/+$/g, '');
    const storageKey = `${cleanFolder}/${randomIdentifier}${extension}`;

    // Cálculo do hash SHA-256 para integridade
    const fileHashSha256 = cryptoUtils.calculateFileHash(file.buffer);

    // Upload físico através do provedor
    await storageProvider.putObject(
      bucketName,
      storageKey,
      file.buffer,
      file.mimetype || 'application/octet-stream',
      {
        originalFilename,
        fileHashSha256,
        ...metadata
      }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'STORAGE_FILE',
        resourceId: storageKey,
        metadata: {
          bucketName,
          originalFilename,
          fileSizeBytes,
          mimeType: file.mimetype
        }
      });
    }

    return {
      storageKey,
      bucketName,
      fileSizeBytes,
      mimeType: file.mimetype || 'application/octet-stream',
      originalFilename,
      fileHashSha256
    };
  }

  /**
   * Obtém o conteúdo e os metadados de um ficheiro a partir da sua chave de armazenamento.
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @param {object} [context={}]
   * @returns {Promise<{ stream: any, contentType: string, contentLength: number }>}
   */
  async getFile(bucketName, storageKey, context = {}) {
    if (!bucketName || !storageKey) {
      throw ValidationError.fieldRequired('bucketName e storageKey');
    }

    const exists = await storageProvider.objectExists(bucketName, storageKey);
    if (!exists) {
      throw NotFoundError.resource('Ficheiro de Armazenamento', storageKey);
    }

    const result = await storageProvider.getObject(bucketName, storageKey);

    if (context.userId || context.ipAddress) {
      await storageRepository.recordStorageAccessAudit({
        storageKey,
        bucketName,
        userId: context.userId || null,
        action: 'EXPORT_DATA',
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        metadata: { directStream: true }
      });
    }

    return result;
  }

  /**
   * Gera uma URL assinada temporária para descarregamento seguro de ficheiro confidencial.
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @param {number} [expiresInSeconds] - Tempo de validade em segundos
   * @param {object} [context={}]
   * @returns {Promise<{ signedUrl: string, expiresInSeconds: number }>}
   */
  async getSignedDownloadUrl(bucketName, storageKey, expiresInSeconds = null, context = {}) {
    if (!bucketName || !storageKey) {
      throw ValidationError.fieldRequired('bucketName e storageKey');
    }

    const exists = await storageProvider.objectExists(bucketName, storageKey);
    if (!exists) {
      throw NotFoundError.resource('Ficheiro de Armazenamento', storageKey);
    }

    const ttl = expiresInSeconds || storageConfig.signedUrlTtl.privateDownload;
    const signedUrl = await storageProvider.getSignedDownloadUrl(bucketName, storageKey, ttl);

    if (context.userId || context.ipAddress) {
      await storageRepository.recordStorageAccessAudit({
        storageKey,
        bucketName,
        userId: context.userId || null,
        action: 'EXPORT_DATA',
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        metadata: { ttl, signedUrlGenerated: true }
      });
    }

    return {
      signedUrl,
      expiresInSeconds: ttl
    };
  }

  /**
   * Elimina um objeto do armazenamento de forma segura.
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @param {object} [context={}]
   * @returns {Promise<{ message: string, storageKey: string }>}
   */
  async deleteFile(bucketName, storageKey, context = {}) {
    if (!bucketName || !storageKey) {
      throw ValidationError.fieldRequired('bucketName e storageKey');
    }

    const exists = await storageProvider.objectExists(bucketName, storageKey);
    if (!exists) {
      throw NotFoundError.resource('Ficheiro de Armazenamento', storageKey);
    }

    await storageProvider.deleteObject(bucketName, storageKey);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'STORAGE_FILE',
        resourceId: storageKey,
        metadata: {
          bucketName,
          deletedBy: context.userId || null
        }
      });
    }

    return {
      message: 'Ficheiro eliminado com sucesso do armazenamento.',
      storageKey
    };
  }

  /**
   * Consulta os dados volumétricos consolidados dos buckets e documentos da plataforma.
   *
   * @param {object} actingUser
   * @returns {Promise<object>}
   */
  async getStorageStats(actingUser) {
    if (actingUser && actingUser.role !== 'ADMIN' && actingUser.role !== 'AUDITOR') {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR'
      ]);
    }

    const stats = await storageRepository.getStorageUsageStats();
    return {
      provider: storageConfig.provider,
      buckets: storageConfig.buckets,
      stats: {
        documentsBucketSizeBytes: Number(stats.documentsBucketSizeBytes),
        documentsCount: stats.documentsCount,
        kycDocumentsCount: stats.kycCount,
        groupAttachmentsCount: stats.attachmentsCount
      }
    };
  }
}

// Instância singleton do serviço de armazenamento
const storageService = new StorageService();

module.exports = storageService;