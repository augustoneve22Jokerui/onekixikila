const identityService = require('./identity.service');
const privateDownloadService = require('../storage/private-download.service');
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
      // Confirma autorização KYC pelo ID do documento antes de aceder ao storage.
      const documentRecord = await identityService.getDocumentForDownload(req.user, documentId);

      if (req.recordAudit) {
        await req.recordAudit({
          action: 'EXPORT_DATA',
          resourceType: 'VERIFICATION_DOCUMENT',
          resourceId: documentId,
          metadata: {
            filename: documentRecord.original_filename,
            ownerUserId: documentRecord.user_id,
            delivery: 'authenticated-private-stream'
          }
        });
      }

      // O serviço privado volta a validar categoria/titularidade, grava auditoria de storage
      // e devolve o stream do provedor (disco local ou bucket privado), sem expor a storageKey.
      const file = await privateDownloadService.getAuthorizedFileStream(
        req.user,
        documentRecord.storage_key,
        {
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestId: req.id
        }
      );

      if (!file || !file.stream || typeof file.stream.pipe !== 'function') {
        throw new Error('O provedor de armazenamento não devolveu um stream válido para o documento KYC.');
      }

      const originalName = String(file.originalFilename || documentRecord.original_filename || 'documento-identidade')
        .replace(/[\\/\r\n\u0000-\u001f\u007f]/g, '_')
        .replace(/"/g, '_')
        .slice(0, 180) || 'documento-identidade';
      const encodedName = encodeURIComponent(originalName).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      const asciiName = originalName.replace(/[^\x20-\x7E]/g, '_').replace(/[\\/";%]/g, '_');
      const declaredMime = String(file.contentType || documentRecord.mime_type || 'application/octet-stream').split(';')[0].trim().toLowerCase();

      // Apenas PDF e formatos raster comuns são servidos inline; SVG/HTML/outros ficam como download.
      const inlineMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
      const canPreviewInline = inlineMimeTypes.has(declaredMime);
      const contentType = canPreviewInline ? declaredMime : 'application/octet-stream';

      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', (canPreviewInline ? 'inline' : 'attachment') + '; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodedName);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

      const contentLength = Number(file.contentLength);
      if (Number.isFinite(contentLength) && contentLength > 0) {
        res.setHeader('Content-Length', String(contentLength));
      }

      file.stream.once('error', error => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        next(error);
      });

      return file.stream.pipe(res);
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
