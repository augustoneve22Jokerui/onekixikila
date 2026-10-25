const express = require('express');
const documentsController = require('./documents.controller');
const { authenticate } = require('../../middleware/authenticate');
const { authorize, requireGroupMembership } = require('../../middleware/authorize');
const { uploadGroupDocument } = require('../../middleware/upload-limits');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const {
  uploadDocumentSchema,
  documentIdParamSchema,
  groupIdParamSchema,
  listDocumentsQuerySchema,
  verifyDocumentSchema
} = require('./documents.schemas');
const { userIdParamSchema } = require('../../shared/validation/identifiers');

const router = express.Router();

/**
 * @route   POST /upload
 * @desc    Upload de documento privado (limite físico inegociável de 5 MB)
 * @access  Privado (Membros autenticados)
 */
router.post(
  '/upload',
  authenticate,
  uploadGroupDocument('document'),
  validateBody(uploadDocumentSchema),
  documentsController.uploadDocument
);

/**
 * @route   GET /my
 * @desc    Consulta paginada dos documentos pertencentes ao utilizador autenticado
 * @access  Privado
 */
router.get(
  '/my',
  authenticate,
  validateQuery(listDocumentsQuerySchema),
  documentsController.listUserDocuments
);

/**
 * @route   GET /users/:userId
 * @desc    Consulta paginada dos documentos de um utilizador específico (Anti-IDOR)
 * @access  Privado (Titular ou Auditores/Admin)
 */
router.get(
  '/users/:userId',
  authenticate,
  validateParams(userIdParamSchema),
  validateQuery(listDocumentsQuerySchema),
  documentsController.listUserDocuments
);

/**
 * @route   GET /groups/:groupId
 * @desc    Consulta paginada dos documentos e anexos partilhados num grupo de Kixikila
 * @access  Privado (Membros ativos do grupo ou Administradores)
 */
router.get(
  '/groups/:groupId',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  validateParams(groupIdParamSchema),
  validateQuery(listDocumentsQuerySchema),
  documentsController.listGroupDocuments
);

/**
 * @route   GET /:documentId/download
 * @desc    Descarrega com autorização restrita um documento privado (auditoria de exportação)
 * @access  Privado (Titular, membros do grupo correspondente ou Auditores)
 */
router.get(
  '/:documentId/download',
  authenticate,
  validateParams(documentIdParamSchema),
  documentsController.downloadDocument
);

/**
 * @route   POST /:documentId/verify
 * @desc    Homologação ou invalidação técnica de documento de identidade
 * @access  Privado (Exclusivo ADMIN e AUDITOR)
 */
router.post(
  '/:documentId/verify',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(documentIdParamSchema),
  validateBody(verifyDocumentSchema),
  documentsController.verifyDocument
);

/**
 * @route   DELETE /:documentId
 * @desc    Elimina um documento do cofre privado e da base de dados
 * @access  Privado (Titular, líder do grupo ou Administradores)
 */
router.delete(
  '/:documentId',
  authenticate,
  validateParams(documentIdParamSchema),
  documentsController.deleteDocument
);

module.exports = router;