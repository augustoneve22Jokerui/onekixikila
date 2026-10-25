const express = require('express');
const chatController = require('./chat.controller');
const { authenticate } = require('../../middleware/authenticate');
const { requireGroupMembership } = require('../../middleware/authorize');
const { chatLimiter } = require('../../middleware/rate-limit');
const { uploadAudioMessage, uploadGroupDocument } = require('../../middleware/upload-limits');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const {
  sendTextMessageSchema,
  sendAudioMessageSchema,
  sendDocumentMessageSchema,
  reportMessageSchema,
  resolveReportSchema,
  listMessagesQuerySchema,
  messageIdParamSchema,
  reportIdParamSchema,
  groupIdParamSchema
} = require('./chat.schemas');
const { createParamIdSchema } = require('../../shared/validation/identifiers');

const router = express.Router();
const attachmentIdParamSchema = createParamIdSchema('attachmentId');

/**
 * @route   POST /groups/:groupId/messages/text
 * @desc    Envia uma mensagem de texto no chat do grupo de Kixikila
 * @access  Privado (Membros ativos do grupo - protegido por rate limiting)
 */
router.post(
  '/groups/:groupId/messages/text',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  chatLimiter,
  validateParams(groupIdParamSchema),
  validateBody(sendTextMessageSchema),
  chatController.sendTextMessage
);

/**
 * @route   POST /groups/:groupId/messages/audio
 * @desc    Envia uma nota de voz gravada para o chat do grupo
 * @access  Privado (Membros ativos do grupo - limite de 10 MB / 120s)
 */
router.post(
  '/groups/:groupId/messages/audio',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  chatLimiter,
  uploadAudioMessage('audio'),
  validateParams(groupIdParamSchema),
  validateBody(sendAudioMessageSchema),
  chatController.sendAudioMessage
);

/**
 * @route   POST /groups/:groupId/messages/document
 * @desc    Envia um documento anexo para o chat do grupo (estritamente limitado a 5 MB)
 * @access  Privado (Membros ativos do grupo)
 */
router.post(
  '/groups/:groupId/messages/document',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  uploadGroupDocument('document'),
  validateParams(groupIdParamSchema),
  validateBody(sendDocumentMessageSchema),
  chatController.sendDocumentMessage
);

/**
 * @route   GET /groups/:groupId/messages
 * @desc    Consulta cronológica paginada da linha do tempo de mensagens do grupo
 * @access  Privado (Membros ativos do grupo ou Auditores)
 */
router.get(
  '/groups/:groupId/messages',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  validateParams(groupIdParamSchema),
  validateQuery(listMessagesQuerySchema),
  chatController.getGroupMessages
);

/**
 * @route   GET /groups/:groupId/messages/pinned
 * @desc    Consulta os avisos e mensagens fixadas no topo da sala
 * @access  Privado (Membros ativos do grupo)
 */
router.get(
  '/groups/:groupId/messages/pinned',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  validateParams(groupIdParamSchema),
  chatController.getPinnedMessages
);

/**
 * @route   DELETE /messages/:messageId
 * @desc    Eliminação lógica de uma mensagem (Soft Delete pelo autor ou líder)
 * @access  Privado
 */
router.delete(
  '/messages/:messageId',
  authenticate,
  validateParams(messageIdParamSchema),
  chatController.deleteMessage
);

/**
 * @route   PATCH /messages/:messageId/pin
 * @desc    Fixa ou desafixa um aviso no topo da sala do grupo
 * @access  Privado (Liderança do grupo ou Administradores)
 */
router.patch(
  '/messages/:messageId/pin',
  authenticate,
  validateParams(messageIdParamSchema),
  chatController.togglePinMessage
);

/**
 * @route   POST /messages/:messageId/read
 * @desc    Confirma a leitura de uma mensagem de grupo (Read Receipt)
 * @access  Privado (Participante da conversa)
 */
router.post(
  '/messages/:messageId/read',
  authenticate,
  validateParams(messageIdParamSchema),
  chatController.markMessageAsRead
);

/**
 * @route   GET /attachments/:attachmentId/download
 * @desc    Descarrega com autorização restrita um anexo privado de mensagem
 * @access  Privado (Membros com filiação ativa no grupo do anexo)
 */
router.get(
  '/attachments/:attachmentId/download',
  authenticate,
  validateParams(attachmentIdParamSchema),
  chatController.downloadAttachment
);

/**
 * @route   POST /groups/:groupId/messages/:messageId/report
 * @desc    Submete uma denúncia formal contra mensagem abusiva no chat
 * @access  Privado (Membros ativos do grupo)
 */
router.post(
  '/groups/:groupId/messages/:messageId/report',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  validateParams(groupIdParamSchema),
  validateBody(reportMessageSchema),
  chatController.reportMessage
);

/**
 * @route   GET /groups/:groupId/reports
 * @desc    Lista denúncias comunitárias de mensagens de determinado grupo
 * @access  Privado (Líder titular ou Vice-Líder com poderes de moderação)
 */
router.get(
  '/groups/:groupId/reports',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  validateParams(groupIdParamSchema),
  chatController.listGroupReports
);

/**
 * @route   POST /reports/:reportId/resolve
 * @desc    Delibera e conclui uma denúncia de mensagem com parecer e censura
 * @access  Privado (Líder do grupo, Moderadores comunitários ou Administradores)
 */
router.post(
  '/reports/:reportId/resolve',
  authenticate,
  validateParams(reportIdParamSchema),
  validateBody(resolveReportSchema),
  chatController.resolveReport
);

module.exports = router;