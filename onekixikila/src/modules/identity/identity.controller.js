const path = require('path');
const fs = require('fs');
const identityService = require('./identity.service');
const storageConfig = require('../../config/storage');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Identidade e Conformidade KYC.
 * Mapeia os pedidos de submissão de Bilhete de Identidade, fotografias faciais,
 * consulta de estado de aprovação, pareceres de auditoria e transferência segura de documentos privados.
 */
class IdentityController {
  /**
   * Submissão de documentos e dados para verificação de identidade.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async submitVerification(req, res, next) {
    try {
      const result = await identityService.submitVerification(
        req.user,
        req.body,
        req.files,
        {
          requestId: req.id,
          recordAudit: req.recordAudit
        }
      );

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          verificationId: result.verificationId,
          status: result.status,
          submittedAt: result.submittedAt
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o estado e o histórico de verificação de identidade do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getMyVerification(req, res, next) {
    try {
      const verification = await identityService.getMyVerification(req.user);

      return res.status(200).json({
        success: true,
        data: {
          verification
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta detalhada de um processo KYC específico por ID (Uso administrativo ou pelo próprio titular).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getVerificationById(req, res, next) {
    try {
      const verificationId = req.params.verificationId;
      const verification = await identityService.getVerificationById(req.user, verificationId);

      return res.status(200).json({
        success: true,
        data: {
          verification
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Emite o parecer técnico administrativo sobre a verificação KYC (Aprovar / Rejeitar / Revisão).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async reviewVerification(req, res, next) {
    try {
      const verificationId = req.params.verificationId;
      const updated = await identityService.reviewVerification(
        req.user,
        verificationId,
        req.body,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: 'Parecer de conformidade KYC registado com sucesso.',
        data: {
          verification: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Descarrega com autorização restrita um documento privado de identidade (PDF/Imagem).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async downloadDocument(req, res, next) {
    try {
      const documentId = req.params.documentId;
      const documentRecord = await identityService.getDocumentForDownload(req.user, documentId);

      if (req.recordAudit) {
        await req.recordAudit({
          action: 'EXPORT_DATA',
          resourceType: 'VERIFICATION_DOCUMENT',
          resourceId: documentId,
          metadata: {
            filename: documentRecord.original_filename,
            ownerUserId: documentRecord.user_id
          }
        });
      }

      // Se armazenado em disco local (ambiente de contingência)
      if (storageConfig.provider === 'local-disk') {
        const filePath = path.join(storageConfig.localUploadsDir, documentRecord.storage_key);

        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            success: false,
            error: {
              code: 'DOCUMENT_FILE_NOT_FOUND',
              message: 'O ficheiro físico solicitado não foi localizado no armazenamento privado.'
            }
          });
        }

        res.setHeader('Content-Type', documentRecord.mime_type);
        res.setHeader('Content-Disposition', `attachment; filename="${documentRecord.original_filename}"`);
        return res.sendFile(filePath);
      }

      // Em provedor compatível com S3 (Neon Object Storage), envia instrução controlada
      return res.status(200).json({
        success: true,
        data: {
          documentId: documentRecord.id,
          storageKey: documentRecord.storage_key,
          bucket: documentRecord.bucket_name,
          mimeType: documentRecord.mime_type
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Lista a fila de processos de conformidade KYC para a equipa de auditoria e administração.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listVerifications(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        tier: req.query.tier,
        search: paginationParams.search
      };

      const result = await identityService.listVerifications(req.user, filters, paginationParams);

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
const identityController = new IdentityController();
identityController.submitVerification = identityController.submitVerification.bind(identityController);
identityController.getMyVerification = identityController.getMyVerification.bind(identityController);
identityController.getVerificationById = identityController.getVerificationById.bind(identityController);
identityController.reviewVerification = identityController.reviewVerification.bind(identityController);
identityController.downloadDocument = identityController.downloadDocument.bind(identityController);
identityController.listVerifications = identityController.listVerifications.bind(identityController);

module.exports = identityController;