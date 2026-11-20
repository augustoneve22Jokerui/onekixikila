const multer = require('multer');
const storageConfig = require('../config/storage');

// Armazenamento em memória (buffer) para permitir inspeção e envio direto ao Neon Object Storage
const memoryStorage = multer.memoryStorage();

/**
 * Filtro de validação de tipos MIME autorizados.
 * @param {string[]} allowedMimes
 * @param {string} categoryLabel
 */
const createMimeFilter = (allowedMimes, categoryLabel) => {
  return (req, file, cb) => {
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const error = new Error(`Formato de ficheiro não suportado para ${categoryLabel}. Formatos aceites: ${allowedMimes.join(', ')}`);
      error.code = 'UNSUPPORTED_MEDIA_TYPE';
      error.status = 415;
      cb(error, false);
    }
  };
};

/**
 * Uploader para Documentos de Grupo e Anexos.
 * Limite físico inegociável de 5 MB (5.242.880 bytes).
 */
const documentUploader = multer({
  storage: memoryStorage,
  limits: {
    fileSize: storageConfig.limits.documentMaxBytes, // 5.242.880 bytes
    files: 1
  },
  fileFilter: createMimeFilter(storageConfig.allowedMimeTypes.documents, 'documentos')
});

/**
 * Uploader para Mensagens de Áudio no chat.
 * Limite físico de 10 MB (10.485.760 bytes).
 */
const audioUploader = multer({
  storage: memoryStorage,
  limits: {
    fileSize: storageConfig.limits.audioMaxBytes, // 10.485.760 bytes
    files: 1
  },
  fileFilter: createMimeFilter(storageConfig.allowedMimeTypes.audio, 'mensagens de áudio')
});

/**
 * Uploader para Documentos de Verificação de Identidade (KYC - Bilhete de Identidade e Selfie).
 * Limite de 5 MB.
 */
const identityUploader = multer({
  storage: memoryStorage,
  limits: {
    fileSize: storageConfig.limits.imageMaxBytes, // 5.242.880 bytes
    files: 2
  },
  fileFilter: createMimeFilter(
    [...storageConfig.allowedMimeTypes.images, 'application/pdf'],
    'documentos de identidade'
  )
});

/**
 * Middleware de invólucro para captura segura de exceções do Multer.
 * Converte erros de tamanho e formato em respostas HTTP estruturadas.
 *
 * @param {import('express').RequestHandler} uploaderMiddleware
 * @param {string} fieldName - Nome do campo de formulário multipart
 * @param {number} maxBytes - Limite em bytes para mensagem clara ao utilizador
 * @returns {import('express').RequestHandler}
 */
const handleUpload = (uploaderMiddleware, fieldName, maxBytes) => {
  return (req, res, next) => {
    uploaderMiddleware(req, res, (err) => {
      if (!err) {
        return next();
      }

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
          return res.status(413).json({
            success: false,
            error: {
              code: 'FILE_SIZE_EXCEEDED',
              message: `O ficheiro enviado excede o limite máximo autorizado de ${maxMb} MB (${maxBytes} bytes).`,
              maxBytes
            }
          });
        }

        return res.status(400).json({
          success: false,
          error: {
            code: 'UPLOAD_ERROR',
            message: `Erro no upload: ${err.message}`
          }
        });
      }

      if (err.code === 'UNSUPPORTED_MEDIA_TYPE') {
        return res.status(415).json({
          success: false,
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: err.message
          }
        });
      }

      return next(err);
    });
  };
};

module.exports = {
  uploadGroupDocument: (fieldName = 'document') =>
    handleUpload(documentUploader.single(fieldName), fieldName, storageConfig.limits.documentMaxBytes),

  uploadAudioMessage: (fieldName = 'audio') =>
    handleUpload(audioUploader.single(fieldName), fieldName, storageConfig.limits.audioMaxBytes),

  uploadIdentityVerification: (fields = [{ name: 'idDocument', maxCount: 1 }, { name: 'facialPhoto', maxCount: 1 }]) =>
    handleUpload(identityUploader.fields(fields), 'identity', storageConfig.limits.documentMaxBytes)
};