'use strict';

const express = require('express');
const identityController = require('./identity.controller');
const { authenticate } = require('../../middleware/authenticate');
const { authorize } = require('../../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const { uploadIdentityVerification } = require('../../middleware/upload-limits');
const {
  submitVerificationSchema,
  reviewVerificationSchema,
  listVerificationsQuerySchema,
  verificationIdParamSchema
} = require('./identity.schemas');
const { createParamIdSchema } = require('../../shared/validation/identifiers');

const router = express.Router();
const documentIdParamSchema = createParamIdSchema('documentId');

/**
 * Envia documentos e dados para verificação de identidade KYC.
 * POST /api/v1/identity/submit
 * Acesso: utilizador autenticado.
 */
router.post(
  '/submit',
  authenticate,
  uploadIdentityVerification([
    { name: 'idDocument', maxCount: 1 },
    { name: 'facialPhoto', maxCount: 1 }
  ]),
  validateBody(submitVerificationSchema),
  identityController.submitVerification
);

/**
 * Consulta o estado KYC do próprio utilizador.
 * GET /api/v1/identity/me
 * Acesso: utilizador autenticado.
 */
router.get(
  '/me',
  authenticate,
  identityController.getMyVerification
);

/**
 * Lista os processos KYC com filtros e paginação.
 * Compatibilidade: GET /api/v1/identity/queue
 * Alias de revisão administrativa: GET /api/v1/identity/admin/identity-review
 * Acesso: ADMIN ou AUDITOR.
 */
router.get(
  ['/queue', '/admin/identity-review'],
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateQuery(listVerificationsQuerySchema),
  identityController.listVerifications
);

/**
 * Consulta um processo KYC por UUID.
 * Compatibilidade: GET /api/v1/identity/:verificationId
 * Alias de detalhe administrativo:
 * GET /api/v1/identity/admin/identity-review/:verificationId
 * Acesso: titular autorizado ou ADMIN/AUDITOR, conforme a política do serviço.
 */
router.get(
  '/admin/identity-review/:verificationId',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(verificationIdParamSchema),
  identityController.getVerificationById
);

router.get(
  '/:verificationId',
  authenticate,
  validateParams(verificationIdParamSchema),
  identityController.getVerificationById
);

/**
 * Emite decisão de revisão KYC através dos handlers e validações existentes.
 * Compatibilidade: POST /api/v1/identity/:verificationId/review
 * Alias administrativo: PATCH /api/v1/identity/admin/identity-review/:verificationId/decision
 * Acesso: ADMIN ou AUDITOR.
 */
router.patch(
  '/admin/identity-review/:verificationId/decision',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(verificationIdParamSchema),
  validateBody(reviewVerificationSchema),
  identityController.reviewVerification
);

router.post(
  '/:verificationId/review',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(verificationIdParamSchema),
  validateBody(reviewVerificationSchema),
  identityController.reviewVerification
);

/**
 * Devolve/serve documento privado através do handler autenticado existente.
 * Compatibilidade: GET /api/v1/identity/documents/:documentId/download
 * Alias administrativo: GET /api/v1/identity/admin/identity-review/:verificationId/documents/:documentId/url
 * Nota: o handler atual valida autorização pelo documento e regista EXPORT_DATA;
 * a emissão de URL pré-assinada S3/MinIO requer uma implementação de storage service.
 */
router.get(
  '/admin/identity-review/:verificationId/documents/:documentId/url',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(verificationIdParamSchema),
  validateParams(documentIdParamSchema),
  identityController.downloadDocument
);

router.get(
  '/documents/:documentId/download',
  authenticate,
  validateParams(documentIdParamSchema),
  identityController.downloadDocument
);

module.exports = router;
