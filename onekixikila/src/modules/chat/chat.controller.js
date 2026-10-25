const path = require('path');
const fs = require('fs');
const chatService = require('./chat.service');
const attachmentService = require('./attachment.service');
const storageConfig = require('../../config/storage');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Chat e Comunicação de Grupos.
 * Trata os pedidos de envio de texto, notas de voz, anexos de documentos até 5 MB,
 * consulta de mensagens, avisos fixados, confirmação de leitura, download seguro de anexos
 * e moderação comunitária.
 */
class ChatController {
  /**
   * Envia uma mensagem de texto para o chat do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async sendTextMessage(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const message = await chatService.sendTextMessage(
        req.user,
        groupId,
        req.body,
        {
          requestId: req.id,
          recordAudit: req.recordAudit
        }
      );

      return res.status(201).json({
        success: true,
        message: 'Mensagem enviada com sucesso.',
        data: {
          message
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Envia uma mensagem de áudio (nota de voz gravada).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async sendAudioMessage(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_AUDIO_FILE',
            message: 'O ficheiro de áudio é obrigatório no campo "audio".'
          }
        });
      }

      const message = await chatService.sendAudioMessage(
        req.user,
        groupId,
        req.body,
        file,
        {
          requestId: req.id,
          recordAudit: req.recordAudit
        }
      );

      return res.status(201).json({
        success: true,
        message: 'Mensagem de áudio enviada com sucesso.',
        data: {
          message
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Envia um documento anexo para o chat do grupo (estritamente limitado a 5 MB).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async sendDocumentMessage(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_DOCUMENT_FILE',
            message: 'O ficheiro de documento é obrigatório no campo "document".'
          }
        });
      }

      const message = await chatService.sendDocumentMessage(
        req.user,
        groupId,
        req.body,
        file,
        {
          requestId: req.id,
          recordAudit: req.recordAudit
        }
      );

      return res.status(201).json({
        success: true,
        message: 'Documento enviado com sucesso para o grupo.',
        data: {
          message
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a linha do tempo cronológica de mensagens de um grupo com paginação.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupMessages(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const paginationParams = calculatePaginationParams(req.query);

      const options = {
        page: paginationParams.page,
        limit: paginationParams.limit,
        offset: paginationParams.offset,
        before: req.query.before,
        messageType: req.query.messageType
      };

      const result = await chatService.getGroupMessages(req.user, groupId, options);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os avisos e mensagens fixadas no topo do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getPinnedMessages(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const pinnedMessages = await chatService.getPinnedMessages(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: {
          pinnedMessages
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Elimina logicamente uma mensagem do chat (Soft Delete).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async deleteMessage(req, res, next) {
    try {
      const messageId = req.params.messageId;
      const result = await chatService.deleteMessage(req.user, messageId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          messageId: result.messageId
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Fixa ou desafixa um aviso no topo da sala de conversação (Ação de Liderança).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async togglePinMessage(req, res, next) {
    try {
      const messageId = req.params.messageId;
      const { isPinned } = req.body;

      if (typeof isPinned !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PIN_PAYLOAD',
            message: 'O campo isPinned deve ser um booleano (true ou false).'
          }
        });
      }

      const updated = await chatService.togglePinMessage(req.user, messageId, isPinned, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: isPinned ? 'Aviso fixado no topo do grupo.' : 'Aviso desafixado.',
        data: {
          message: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Confirma a leitura de uma mensagem de grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async markMessageAsRead(req, res, next) {
    try {
      const { messageId } = req.params;
      const { groupId } = req.body;

      if (!groupId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_GROUP_ID',
            message: 'O identificador do grupo (groupId) é obrigatório.'
          }
        });
      }

      const receipt = await chatService.markMessageAsRead(req.user, messageId, groupId);

      return res.status(200).json({
        success: true,
        data: {
          receipt
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Descarrega com autorização restrita um anexo privado de mensagem (áudio ou documento).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async downloadAttachment(req, res, next) {
    try {
      const attachmentId = req.params.attachmentId;
      const attachment = await attachmentService.getAttachmentForDownload(req.user, attachmentId);

      // Armazenamento em disco local (ambiente de contingência)
      if (storageConfig.provider === 'local-disk') {
        const filePath = path.join(storageConfig.localUploadsDir, attachment.storage_key);

        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            success: false,
            error: {
              code: 'ATTACHMENT_NOT_FOUND',
              message: 'O ficheiro físico solicitado não foi localizado no armazenamento privado.'
            }
          });
        }

        res.setHeader('Content-Type', attachment.mime_type);
        res.setHeader('Content-Disposition', `attachment; filename="${attachment.original_filename}"`);
        return res.sendFile(filePath);
      }

      // Em produção com S3/Neon Object Storage
      return res.status(200).json({
        success: true,
        data: {
          attachmentId: attachment.id,
          storageKey: attachment.storage_key,
          bucket: attachment.bucket_name,
          mimeType: attachment.mime_type,
          originalFilename: attachment.original_filename
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Submete uma denúncia contra mensagem imprópria ou abusiva.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async reportMessage(req, res, next) {
    try {
      const { groupId, messageId } = req.params;
      const { reason } = req.body;

      const result = await chatService.reportMessage(req.user, groupId, messageId, reason, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          report: result.report
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Delibera e conclui uma denúncia de mensagem (Liderança do grupo ou Moderação).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async resolveReport(req, res, next) {
    try {
      const reportId = req.params.reportId;
      const result = await chatService.resolveReport(req.user, reportId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          report: result.report
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Lista denúncias de mensagens de determinado grupo para a liderança.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroupReports(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status
      };

      const result = await chatService.listGroupReports(req.user, groupId, filters, paginationParams);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const chatController = new ChatController();
chatController.sendTextMessage = chatController.sendTextMessage.bind(chatController);
chatController.sendAudioMessage = chatController.sendAudioMessage.bind(chatController);
chatController.sendDocumentMessage = chatController.sendDocumentMessage.bind(chatController);
chatController.getGroupMessages = chatController.getGroupMessages.bind(chatController);
chatController.getPinnedMessages = chatController.getPinnedMessages.bind(chatController);
chatController.deleteMessage = chatController.deleteMessage.bind(chatController);
chatController.togglePinMessage = chatController.togglePinMessage.bind(chatController);
chatController.markMessageAsRead = chatController.markMessageAsRead.bind(chatController);
chatController.downloadAttachment = chatController.downloadAttachment.bind(chatController);
chatController.reportMessage = chatController.reportMessage.bind(chatController);
chatController.resolveReport = chatController.resolveReport.bind(chatController);
chatController.listGroupReports = chatController.listGroupReports.bind(chatController);

module.exports = chatController;