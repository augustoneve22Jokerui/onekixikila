const path = require('path');
const env = require('./env');

const storageConfig = Object.freeze({
  provider: env.STORAGE_ENDPOINT ? 's3-compatible' : 'local-disk',

  // Configuração S3 / Neon Object Storage
  s3: {
    endpoint: env.STORAGE_ENDPOINT || undefined,
    region: env.STORAGE_REGION,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY_ID || '',
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY || ''
    },
    forcePathStyle: true,
    signatureVersion: 'v4'
  },

  // Buckets Oficiais previstos na plataforma
  buckets: {
    uploads: env.STORAGE_BUCKET_UPLOADS,   // 'upload' - ficheiros em triagem ou temporários
    assets: env.STORAGE_BUCKET_ASSETS,     // 'assets' - ficheiros públicos da aplicação
    documents: env.STORAGE_BUCKET_DOCUMENTS // 'documentos' - estritamente privado (KYC, contratos, anexos)
  },

  // Prazos de validade para URLs assinadas temporárias (segundos)
  signedUrlTtl: {
    privateDownload: 900, // 15 minutos
    upload: 600           // 10 minutos
  },

  // Limites estritos de ficheiro (em Bytes)
  limits: {
    documentMaxBytes: env.MAX_DOCUMENT_SIZE_BYTES, // 5.242.880 bytes (5 MB obrigatórios)
    audioMaxBytes: env.MAX_AUDIO_SIZE_BYTES,       // 10.485.760 bytes (10 MB)
    imageMaxBytes: env.MAX_IMAGE_SIZE_BYTES        // 5.242.880 bytes (5 MB)
  },

  // Tipos MIME estritamente autorizados por categoria
  allowedMimeTypes: {
    documents: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ],
    audio: [
      'audio/webm',
      'audio/ogg',
      'audio/mp4',
      'audio/aac',
      'audio/mpeg'
    ],
    images: [
      'image/jpeg',
      'image/png',
      'image/webp'
    ]
  },

  // Diretório de contingência local previsto na árvore oficial
  localUploadsDir: path.resolve(__dirname, '../public/uploads')
});

module.exports = storageConfig;