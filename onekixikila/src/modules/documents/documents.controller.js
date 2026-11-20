const path = require('path');
const fs = require('fs');
const documentsService = require('./documents.service');
const storageConfig = require('../../config/storage');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Documentos e Ficheiros Privados.
 * Faz a interface entre os pedidos HTTP REST e a camada de serviços (DocumentsService),
 * gerindo o upload autenticado com teto estrito de 5 MB, download seguro de documentos confidenciais,
 * pareceres de auditoria e listagens paginadas de ficheiros por utilizador e por grupo.
 */
class DocumentsController {
  /**
   * Processa o upload de um documento privado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async uploadDocument(req, res, next) {
    try {
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_FILE',
            message: 'O ficheiro é obrigatório no corpo do formulário multipart.'
          }
        });
      }

      const result = await documentsService.uploadDocument(
        req.user,
        req.body,
        file,
        {
          requestId: req.id,
          recordAudit: req.recordAudit
        }
      );

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          document: result
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Descarrega um documento confidencial após verificação de titularidade ou autorização de auditoria.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async downloadDocument(req, res, next) {
    try {
      const documentId = req.params.documentId;
      const documentRecord = await documentsService.getDocumentForDownload(req.user, documentId, {
        recordAudit: req.recordAudit
      });

      // Se armazenado em contingência de disco local
      if (storageConfig.provider === 'local-disk') {
        const filePath = path.join(storageConfig.localUploadsDir, documentRecord.storage_key);

        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            success: false,
            error: {
              code: 'FILE_NOT_FOUND',
              message: 'O ficheiro físico solicitado não foi localizado no armazenamento privado.'
            }
          });
        }

        res.setHeader('Content-Type', documentRecord.mime_type);
        res.setHeader('Content-Disposition', `attachment; filename="${documentRecord.original_filename}"`);
        return res.sendFile(filePath);
      }

      // Em ambiente de produção com S3 / Neon Object Storage
      return res.status(200).json({
        success: true,
        data: {
          documentId: documentRecord.id,
          category: documentRecord.category,
          storageKey: documentRecord.storage_key,
          bucket: documentRecord.bucket_name,
          mimeType: documentRecord.mime_type,
          originalFilename: documentRecord.original_filename
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Valida ou rejeita a conformidade de um documento de identificação (Ação de Auditoria/Admin).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async verifyDocument(req, res, next) {
    try {
      const documentId = req.params.documentId;
      const result = await documentsService.verifyDocument(
        req.user,
        documentId,
        req.body,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          document: result.document
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Elimina um documento do armazenamento e da base de dados.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async deleteDocument(req, res, next) {
    try {
      const documentId = req.params.documentId;
      const result = await documentsService.deleteDocument(req.user, documentId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a lista paginada de documentos pertencentes a um utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listUserDocuments(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        isVerified: req.query.isVerified !== undefined ? req.query.isVerified === 'true' || req.query.isVerified === '1' : undefined,
        category: req.query.category
      };

      const result = await documentsService.listUserDocuments(
        req.user,
        targetUserId,
        filters,
        paginationParams
      );

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
   * Consulta a lista paginada de documentos e anexos partilhados num grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroupDocuments(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const paginationParams = calculatePaginationParams(req.query);

      const result = await documentsService.listGroupDocuments(
        req.user,
        groupId,
        paginationParams
      );

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
const documentsController = new DocumentsController();
documentsController.uploadDocument = documentsController.uploadDocument.bind(documentsController);
documentsController.downloadDocument = documentsController.downloadDocument.bind(documentsController);
documentsController.verifyDocument = documentsController.verifyDocument.bind(documentsController);
documentsController.deleteDocument = documentsController.deleteDocument.bind(documentsController);
documentsController.listUserDocuments = documentsController.listUserDocuments.bind(documentsController);
documentsController.listGroupDocuments = documentsController.listGroupDocuments.bind(documentsController);

module.exports = documentsController;