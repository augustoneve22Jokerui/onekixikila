const fs = require('fs');
const path = require('path');
const { query } = require('../database/query');
const storageConfig = require('../config/storage');

/**
 * Tarefa agendada para aplicação de políticas de retenção de armazenamento,
 * purga de ficheiros temporários em quarentena e remoção física de anexos de mensagens eliminadas.
 */
class StorageRetentionJob {
  /**
   * Executa a rotina periódica de conformidade e libertação de espaço de armazenamento.
   *
   * @returns {Promise<{
   *   purgedTempDiskFiles: number,
   *   purgedDeletedAttachments: number
   * }>}
   */
  async run() {
    let purgedTempDiskFiles = 0;
    let purgedDeletedAttachments = 0;

    // 1. Limpeza de ficheiros locais temporários órfãos no diretório de contingência (uploads)
    try {
      const tempDir = storageConfig.localUploadsDir;
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        const thresholdTime = Date.now() - 24 * 60 * 60 * 1000; // Ficheiros temporários com mais de 24 horas

        for (const file of files) {
          // Preserva o ficheiro .gitkeep de controlo de versão
          if (file === '.gitkeep') {
            continue;
          }

          const filePath = path.join(tempDir, file);
          const stats = fs.statSync(filePath);

          if (stats.isFile() && stats.mtimeMs < thresholdTime) {
            fs.unlinkSync(filePath);
            purgedTempDiskFiles += 1;
          }
        }
      }
    } catch (diskError) {
      console.error('[STORAGE:RETENTION:DISK_ERROR] Falha na limpeza de uploads locais:', diskError.message);
    }

    // 2. Remoção de registos de anexos de mensagens marcadas como eliminadas há mais de 30 dias
    try {
      const purgeAttachmentsQuery = `
        DELETE FROM chat_attachments
        WHERE message_id IN (
          SELECT id FROM chat_messages
          WHERE is_deleted = TRUE
            AND deleted_at < (NOW() AT TIME ZONE 'UTC' - INTERVAL '30 days')
        );
      `;
      const purgeResult = await query(purgeAttachmentsQuery);
      purgedDeletedAttachments = purgeResult.rowCount || 0;
    } catch (dbError) {
      console.error('[STORAGE:RETENTION:DB_ERROR] Falha ao expurgar anexos eliminados:', dbError.message);
    }

    return {
      purgedTempDiskFiles,
      purgedDeletedAttachments
    };
  }
}

// Instância singleton do job
const storageRetentionJob = new StorageRetentionJob();

module.exports = storageRetentionJob;