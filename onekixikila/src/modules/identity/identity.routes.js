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
 * @route   POST /submit
 * @desc    Submissão de documentos e dados para verificação de identidade KYC
 * @access  Privado (Membros autenticados)
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
 * @route   GET /me
 * @desc    Consulta o estado de verificação cadastral da própria conta
 * @access  Privado
 */
router.get(
  '/me',
  authenticate,
  identityController.getMyVerification
);

/**
 * @route   GET /queue
 * @desc    Consulta paginada da fila de processos KYC para análise de conformidade
 * @access  Privado (Exclusivo ADMIN e AUDITOR)
 */
router.get(
  '/queue',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateQuery(listVerificationsQuerySchema),
  identityController.listVerifications
);

/**
 * @route   GET /:verificationId
 * @desc    Consulta detalhada de um processo específico de verificação
 * @access  Privado (Titular ou Equipa de Auditoria)
 */
router.get(
  '/:verificationId',
  authenticate,
  validateParams(verificationIdParamSchema),
  identityController.getVerificationById
);

/**
 * @route   POST /:verificationId/review
 * @desc    Emissão de parecer técnico administrativo (Aprovação / Rejeição / Revisão)
 * @access  Privado (Exclusivo ADMIN e AUDITOR)
 */
router.post(
  '/:verificationId/review',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(verificationIdParamSchema),
  validateBody(reviewVerificationSchema),
  identityController.reviewVerification
);

/**
 * @route   GET /documents/:documentId/download
 * @desc    Descarrega com autorização restrita um documento privado de identidade
 * @access  Privado (Titular ou Auditores com registo de auditoria)
 */
router.get(
  '/documents/:documentId/download',
  authenticate,
  validateParams(documentIdParamSchema),
  identityController.downloadDocument
);

module.exports = router;