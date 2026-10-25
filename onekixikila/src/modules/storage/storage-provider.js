const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const storageConfig = require('../../config/storage');
const logger = require('../../shared/logging/logger');

/**
 * Adaptador de baixo nível para armazenamento de ficheiros e objetos (Neon Object Storage / S3-compatible).
 * Utiliza o AWS SDK v3 oficial (@aws-sdk/client-s3 e @aws-sdk/s3-request-presigner) com suporte
 * a URLs pré-assinadas temporárias de download e upload, operando em contingência com disco local
 * seguro quando o endpoint de armazenamento em nuvem não estiver configurado.
 */
class StorageProvider {
  constructor() {
    this.logger = logger.child({ module: 'STORAGE_PROVIDER' });
    this.isS3Compatible = storageConfig.provider === 's3-compatible' && Boolean(storageConfig.s3.endpoint);
    this.s3Client = null;

    if (this.isS3Compatible) {
      try {
        this.s3Client = new S3Client({
          endpoint: storageConfig.s3.endpoint,
          region: storageConfig.s3.region || 'eu-central-1',
          credentials: {
            accessKeyId: storageConfig.s3.credentials.accessKeyId || '',
            secretAccessKey: storageConfig.s3.credentials.secretAccessKey || ''
          },
          forcePathStyle: storageConfig.s3.forcePathStyle !== false
        });
        this.logger.info(`[STORAGE_PROVIDER] Cliente S3/Neon conectado ao endpoint: ${storageConfig.s3.endpoint}`);
      } catch (clientError) {
        this.logger.error('[STORAGE_PROVIDER:INIT_ERROR] Falha ao instanciar S3Client:', clientError);
        this.isS3Compatible = false;
      }
    } else {
      this.logger.info(`[STORAGE_PROVIDER] Operando em modo contingência local-disk: ${storageConfig.localUploadsDir}`);
    }
  }

  /**
   * Grava um buffer binário no bucket e chave informados.
   *
   * @param {string} bucketName - Nome do bucket ('documentos', 'upload', 'assets')
   * @param {string} storageKey - Chave de destino opaca (ex: 'chat/groupId/msgId/uuid.pdf')
   * @param {Buffer} buffer - Conteúdo binário
   * @param {string} mimeType - Tipo de conteúdo
   * @param {object} [metadata={}] - Metadados adicionais
   * @returns {Promise<{ bucket: string, key: string, sizeBytes: number }>}
   */
  async putObject(bucketName, storageKey, buffer, mimeType, metadata = {}) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('[STORAGE_PROVIDER] O conteúdo para putObject deve ser um Buffer válido.');
    }

    const cleanKey = storageKey.replace(/^\/+/, '');
    const sizeBytes = buffer.length;

    if (this.isS3Compatible && this.s3Client) {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: cleanKey,
        Body: buffer,
        ContentType: mimeType,
        Metadata: {
          'file-size': String(sizeBytes),
          ...metadata
        }
      });

      await this.s3Client.send(command);

      return {
        bucket: bucketName,
        key: cleanKey,
        sizeBytes
      };
    }

    // Modo contingência em disco local
    const targetPath = path.join(storageConfig.localUploadsDir, bucketName, cleanKey);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(targetPath, buffer);

    return {
      bucket: bucketName,
      key: cleanKey,
      sizeBytes,
      localPath: targetPath
    };
  }

  /**
   * Obtém o conteúdo e os metadados de um objeto do armazenamento.
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @returns {Promise<{ stream: any, contentType: string, contentLength: number }>}
   */
  async getObject(bucketName, storageKey) {
    const cleanKey = storageKey.replace(/^\/+/, '');

    if (this.isS3Compatible && this.s3Client) {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
      });

      const response = await this.s3Client.send(command);

      return {
        stream: response.Body,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength || 0
      };
    }

    // Modo contingência em disco local
    const localPath = path.join(storageConfig.localUploadsDir, bucketName, cleanKey);

    if (!fs.existsSync(localPath)) {
      const directLocalPath = path.join(storageConfig.localUploadsDir, cleanKey);
      if (fs.existsSync(directLocalPath)) {
        const stats = fs.statSync(directLocalPath);
        return {
          stream: fs.createReadStream(directLocalPath),
          contentType: 'application/octet-stream',
          contentLength: stats.size,
          localPath: directLocalPath
        };
      }
      throw new Error(`[STORAGE_PROVIDER] Ficheiro não encontrado no disco local: ${cleanKey}`);
    }

    const stats = fs.statSync(localPath);

    return {
      stream: fs.createReadStream(localPath),
      contentType: 'application/octet-stream',
      contentLength: stats.size,
      localPath
    };
  }

  /**
   * Gera uma URL pré-assinada temporária para descarregamento seguro de ficheiro confidencial.
   *
   * @param {string} bucketName - Nome do bucket
   * @param {string} storageKey - Chave do objeto
   * @param {number} [expiresInSeconds=900] - Validade da assinatura (padrão 15 minutos)
   * @returns {Promise<string>} URL temporária assinada
   */
  async getSignedDownloadUrl(bucketName, storageKey, expiresInSeconds = storageConfig.signedUrlTtl.privateDownload) {
    const cleanKey = storageKey.replace(/^\/+/, '');

    if (this.isS3Compatible && this.s3Client) {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
      });

      return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    }

    // Em modo local-disk, retorna rota da API local controlada
    return `/api/v1/documents/private-stream?key=${encodeURIComponent(cleanKey)}&bucket=${encodeURIComponent(bucketName)}`;
  }

  /**
   * Gera uma URL pré-assinada temporária para envio direto (Upload PUT) ao bucket.
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @param {string} mimeType
   * @param {number} [expiresInSeconds=600] - Validade da assinatura (padrão 10 minutos)
   * @returns {Promise<string>}
   */
  async getSignedUploadUrl(bucketName, storageKey, mimeType, expiresInSeconds = storageConfig.signedUrlTtl.upload) {
    const cleanKey = storageKey.replace(/^\/+/, '');

    if (this.isS3Compatible && this.s3Client) {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: cleanKey,
        ContentType: mimeType
      });

      return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    }

    return `/api/v1/documents/upload`;
  }

  /**
   * Elimina permanentemente um objeto do armazenamento.
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @returns {Promise<boolean>}
   */
  async deleteObject(bucketName, storageKey) {
    const cleanKey = storageKey.replace(/^\/+/, '');

    if (this.isS3Compatible && this.s3Client) {
      const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
      });

      await this.s3Client.send(command);
      return true;
    }

    // Remoção local
    const primaryPath = path.join(storageConfig.localUploadsDir, bucketName, cleanKey);
    const directPath = path.join(storageConfig.localUploadsDir, cleanKey);

    let removed = false;
    if (fs.existsSync(primaryPath)) {
      fs.unlinkSync(primaryPath);
      removed = true;
    } else if (fs.existsSync(directPath)) {
      fs.unlinkSync(directPath);
      removed = true;
    }

    return removed;
  }

  /**
   * Verifica a existência de um objeto no bucket sem descarregar o conteúdo (HeadObject).
   *
   * @param {string} bucketName
   * @param {string} storageKey
   * @returns {Promise<boolean>}
   */
  async objectExists(bucketName, storageKey) {
    const cleanKey = storageKey.replace(/^\/+/, '');

    if (this.isS3Compatible && this.s3Client) {
      try {
        const command = new HeadObjectCommand({
          Bucket: bucketName,
          Key: cleanKey
        });
        await this.s3Client.send(command);
        return true;
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
          return false;
        }
        throw err;
      }
    }

    const primaryPath = path.join(storageConfig.localUploadsDir, bucketName, cleanKey);
    const directPath = path.join(storageConfig.localUploadsDir, cleanKey);

    return fs.existsSync(primaryPath) || fs.existsSync(directPath);
  }
}

// Instância singleton do provedor de armazenamento
const storageProvider = new StorageProvider();

module.exports = storageProvider;