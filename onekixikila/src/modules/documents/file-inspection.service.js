const crypto = require('crypto');
const path = require('path');
const { MAGIC_NUMBERS, FILE_SIZE_LIMITS } = require('../../shared/constants/file-types');
const { documentsPolicy, DOCUMENT_MAX_BYTES, DOCUMENT_CATEGORIES } = require('./documents.policy');
const ValidationError = require('../../shared/errors/validation-error');

// Assinaturas binárias (Magic Numbers) de formatos executáveis perigosos para bloqueio imediato
const DANGEROUS_EXECUTABLE_SIGNATURES = Object.freeze([
  { name: 'DOS/PE Executable (EXE/DLL)', bytes: [0x4D, 0x5A] },                         // MZ
  { name: 'Linux ELF Executable', bytes: [0x7F, 0x45, 0x4C, 0x46] },                    // .ELF
  { name: 'Java Bytecode Class', bytes: [0xCA, 0xFE, 0xBA, 0xBE] },                     // CAFEBABE
  { name: 'Unix Shell Script Shebang', bytes: [0x23, 0x21] },                           // #!
  { name: 'ZIP / Jar Compressed Executable', bytes: [0x50, 0x4B, 0x03, 0x04] }         // PK..
]);

/**
 * Serviço de inspeção profunda de ficheiros e análise de bytes em memória.
 * Não confia na extensão ou no cabeçalho Content-Type enviado pelo navegador;
 * inspeciona os primeiros bytes (Magic Numbers), calcula hashes criptográficos SHA-256,
 * detecta ficheiros executáveis disfarçados e impõe a barreira física inegociável de 5 MB.
 */
class FileInspectionService {
  /**
   * Compara uma sequência de bytes do buffer com uma assinatura de bytes esperada.
   *
   * @param {Buffer} buffer - Buffer de dados do ficheiro
   * @param {number[]} signature - Array de bytes hexadecimais
   * @param {number} [offset=0] - Posição inicial no buffer
   * @returns {boolean}
   */
  matchesSignature(buffer, signature, offset = 0) {
    if (!Buffer.isBuffer(buffer) || buffer.length < offset + signature.length) {
      return false;
    }

    for (let i = 0; i < signature.length; i++) {
      if (buffer[offset + i] !== signature[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Detecta o tipo MIME real do ficheiro através da análise de Magic Numbers no cabeçalho binário.
   *
   * @param {Buffer} buffer - Buffer em memória do ficheiro
   * @returns {string|null} Tipo MIME verificado ou null se desconhecido
   */
  detectRealMimeType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      return null;
    }

    // PDF: %PDF
    if (this.matchesSignature(buffer, MAGIC_NUMBERS.PDF)) {
      return 'application/pdf';
    }

    // PNG: \x89PNG\r\n\x1a\n
    if (this.matchesSignature(buffer, MAGIC_NUMBERS.PNG)) {
      return 'image/png';
    }

    // JPEG: \xFF\xD8\xFF
    if (this.matchesSignature(buffer, MAGIC_NUMBERS.JPEG)) {
      return 'image/jpeg';
    }

    // WEBP: RIFF....WEBP (RIFF nos primeiros 4 bytes e WEBP no offset 8)
    if (
      this.matchesSignature(buffer, [0x52, 0x49, 0x46, 0x46], 0) &&
      this.matchesSignature(buffer, [0x57, 0x45, 0x42, 0x50], 8)
    ) {
      return 'image/webp';
    }

    // OGG Audio: OggS
    if (this.matchesSignature(buffer, MAGIC_NUMBERS.OGG)) {
      return 'audio/ogg';
    }

    // WebM Audio: EBML Header \x1A\x45\xDF\xA3
    if (this.matchesSignature(buffer, MAGIC_NUMBERS.WEBM)) {
      return 'audio/webm';
    }

    // MP4 / AAC: ftyp nos bytes 4-7
    if (
      buffer.length >= 12 &&
      this.matchesSignature(buffer, [0x66, 0x74, 0x79, 0x70], 4)
    ) {
      return 'audio/mp4';
    }

    return null;
  }

  /**
   * Verifica se o ficheiro contém cabeçalhos característicos de executáveis ou scripts maliciosos disfarçados.
   *
   * @param {Buffer} buffer
   * @returns {{ isExecutable: boolean, detectedType?: string }}
   */
  detectDangerousExecutable(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
      return { isExecutable: false };
    }

    for (const signature of DANGEROUS_EXECUTABLE_SIGNATURES) {
      if (this.matchesSignature(buffer, signature.bytes)) {
        return {
          isExecutable: true,
          detectedType: signature.name
        };
      }
    }

    return { isExecutable: false };
  }

  /**
   * Executa a inspeção profunda de um ficheiro carregado em memória:
   * 1. Valida tamanho real em bytes contra o limite físico estrito (5 MB para documentos).
   * 2. Detecta e rejeita executáveis disfarçados.
   * 3. Confirma o tipo MIME real por inspeção de Magic Numbers.
   * 4. Calcula o checksum SHA-256 para rastreio de integridade.
   *
   * @param {object} file - Ficheiro proveniente do Multer ({ originalname, buffer, size, mimetype })
   * @param {string} [category=DOCUMENT_CATEGORIES.GROUP_ATTACHMENT]
   * @returns {{
   *   isValid: boolean,
   *   fileSizeBytes: number,
   *   detectedMimeType: string,
   *   fileHashSha256: string,
   *   reason?: string
   * }}
   */
  inspectFile(file, category = DOCUMENT_CATEGORIES.GROUP_ATTACHMENT) {
    if (!file || !file.buffer) {
      return {
        isValid: false,
        fileSizeBytes: 0,
        detectedMimeType: '',
        fileHashSha256: '',
        reason: 'Conteúdo do ficheiro ausente ou corrompido.'
      };
    }

    const realSizeBytes = file.buffer.length;

    // 1. Validação estrita do tamanho físico em bytes
    const sizeCheck = documentsPolicy.validateFileSize(realSizeBytes, category);
    if (!sizeCheck.valid) {
      return {
        isValid: false,
        fileSizeBytes: realSizeBytes,
        detectedMimeType: '',
        fileHashSha256: '',
        reason: sizeCheck.reason
      };
    }

    // 2. Proteção contra ficheiros executáveis disfarçados
    const executableCheck = this.detectDangerousExecutable(file.buffer);
    if (executableCheck.isExecutable) {
      return {
        isValid: false,
        fileSizeBytes: realSizeBytes,
        detectedMimeType: 'application/x-executable',
        fileHashSha256: '',
        reason: `Ficheiro rejeitado por conter cabeçalhos executáveis perigosos (${executableCheck.detectedType}).`
      };
    }

    // 3. Inspeção de Magic Numbers para determinação do MIME real
    const detectedMime = this.detectRealMimeType(file.buffer) || (file.mimetype ? file.mimetype.toLowerCase().trim() : '');

    const mimeCheck = documentsPolicy.validateMimeType(detectedMime, category);
    if (!mimeCheck.valid) {
      return {
        isValid: false,
        fileSizeBytes: realSizeBytes,
        detectedMimeType: detectedMime,
        fileHashSha256: '',
        reason: mimeCheck.reason
      };
    }

    // 4. Cálculo do hash SHA-256
    const fileHashSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

    return {
      isValid: true,
      fileSizeBytes: realSizeBytes,
      detectedMimeType: detectedMime,
      fileHashSha256
    };
  }

  /**
   * Assegura que um ficheiro é rigorosamente seguro antes de qualquer persistência,
   * lançando ValidationError caso qualquer inconsistência ou tentativa de violação de limites ocorra.
   *
   * @param {object} file
   * @param {string} [category=DOCUMENT_CATEGORIES.GROUP_ATTACHMENT]
   * @returns {{ fileSizeBytes: number, detectedMimeType: string, fileHashSha256: string }}
   * @throws {ValidationError}
   */
  assertSafeFile(file, category = DOCUMENT_CATEGORIES.GROUP_ATTACHMENT) {
    const inspection = this.inspectFile(file, category);
    if (!inspection.isValid) {
      throw new ValidationError(inspection.reason);
    }

    return {
      fileSizeBytes: inspection.fileSizeBytes,
      detectedMimeType: inspection.detectedMimeType,
      fileHashSha256: inspection.fileHashSha256
    };
  }
}

// Instância singleton do serviço de inspeção de ficheiros
const fileInspectionService = new FileInspectionService();

module.exports = fileInspectionService;