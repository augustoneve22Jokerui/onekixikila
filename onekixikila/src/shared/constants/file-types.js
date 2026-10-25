/**
 * Catálogo canónico de tipos de ficheiro, assinaturas de bytes (magic numbers) e limites físicos.
 * Impõe barreiras de conformidade para prevenir uploads maliciosos e garantir o limite de 5 MB.
 */

// Limites físicos de tamanho de ficheiro em Bytes
const FILE_SIZE_LIMITS = Object.freeze({
  DOCUMENT_MAX_BYTES: 5242880,  // 5 MB exatos (5.242.880 bytes) - Regra inegociável
  AUDIO_MAX_BYTES: 10485760,    // 10 MB (10.485.760 bytes)
  IMAGE_MAX_BYTES: 5242880,     // 5 MB
  AVATAR_MAX_BYTES: 2097152     // 2 MB
});

// Categorias e tipos MIME estritamente autorizados
const ALLOWED_MIME_TYPES = Object.freeze({
  DOCUMENTS: Object.freeze([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]),
  AUDIO: Object.freeze([
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/aac',
    'audio/mpeg'
  ]),
  IMAGES: Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp'
  ]),
  KYC: Object.freeze([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ])
});

// Extensões de ficheiro autorizadas por categoria
const ALLOWED_EXTENSIONS = Object.freeze({
  DOCUMENTS: Object.freeze(['.pdf', '.jpg', '.jpeg', '.png', '.webp']),
  AUDIO: Object.freeze(['.webm', '.ogg', '.mp4', '.m4a', '.aac', '.mp3']),
  IMAGES: Object.freeze(['.jpg', '.jpeg', '.png', '.webp'])
});

// Assinaturas canónicas de bytes (Magic Numbers) para validação profunda no buffer
const MAGIC_NUMBERS = Object.freeze({
  PDF: Object.freeze([0x25, 0x50, 0x44, 0x46]),                     // %PDF
  JPEG: Object.freeze([0xFF, 0xD8, 0xFF]),                          // JPEG SOI
  PNG: Object.freeze([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG Signature
  OGG: Object.freeze([0x4F, 0x67, 0x67, 0x53]),                     // OggS
  WEBM: Object.freeze([0x1A, 0x45, 0xDF, 0xA3])                     // EBML (WebM / Matroska)
});

/**
 * Valida se um tipo MIME pertence à lista de documentos autorizados.
 * @param {string} mimeType
 * @returns {boolean}
 */
const isAllowedDocumentMime = (mimeType) => {
  return typeof mimeType === 'string' && ALLOWED_MIME_TYPES.DOCUMENTS.includes(mimeType.toLowerCase());
};

/**
 * Valida se um tipo MIME pertence à lista de mensagens de áudio autorizadas.
 * @param {string} mimeType
 * @returns {boolean}
 */
const isAllowedAudioMime = (mimeType) => {
  return typeof mimeType === 'string' && ALLOWED_MIME_TYPES.AUDIO.includes(mimeType.toLowerCase());
};

/**
 * Valida se um tipo MIME pertence à lista de imagens autorizadas.
 * @param {string} mimeType
 * @returns {boolean}
 */
const isAllowedImageMime = (mimeType) => {
  return typeof mimeType === 'string' && ALLOWED_MIME_TYPES.IMAGES.includes(mimeType.toLowerCase());
};

module.exports = {
  FILE_SIZE_LIMITS,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAGIC_NUMBERS,
  isAllowedDocumentMime,
  isAllowedAudioMime,
  isAllowedImageMime
};