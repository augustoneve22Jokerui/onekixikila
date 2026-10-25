const express = require('express');
const authController = require('./auth.controller');
const { validateBody } = require('../../middleware/validate');
const {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  refreshTokenSchema
} = require('./auth.schemas');
const { authLimiter } = require('../../middleware/rate-limit');
const { authenticate } = require('../../middleware/authenticate');

const router = express.Router();

/**
 * @route   POST /register
 * @desc    Registo de nova conta de utilizador
 * @access  Público (Protegido por rate-limit)
 */
router.post(
  '/register',
  authLimiter,
  validateBody(registerSchema),
  authController.register
);

/**
 * @route   POST /login
 * @desc    Autenticação de utilizador por e-mail ou telefone
 * @access  Público (Protegido por rate-limit anti-força bruta)
 */
router.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  authController.login
);

/**
 * @route   POST /verify-otp
 * @desc    Validação de conta/contacto através de código numérico OTP
 * @access  Público
 */
router.post(
  '/verify-otp',
  authLimiter,
  validateBody(verifyOtpSchema),
  authController.verifyOtp
);

/**
 * @route   POST /resend-otp
 * @desc    Novo envio de código de validação OTP para telemóvel ou e-mail
 * @access  Público
 */
router.post(
  '/resend-otp',
  authLimiter,
  validateBody(resendOtpSchema),
  authController.resendOtp
);

/**
 * @route   POST /forgot-password
 * @desc    Solicitação de recuperação de credenciais de acesso
 * @access  Público
 */
router.post(
  '/forgot-password',
  authLimiter,
  validateBody(forgotPasswordSchema),
  authController.forgotPassword
);

/**
 * @route   POST /reset-password
 * @desc    Redefinição de palavra-passe com token seguro de utilização única
 * @access  Público
 */
router.post(
  '/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  authController.resetPassword
);

/**
 * @route   POST /refresh-token
 * @desc    Renovação de Access Token e rotação de Refresh Token
 * @access  Público
 */
router.post(
  '/refresh-token',
  authLimiter,
  validateBody(refreshTokenSchema),
  authController.refreshToken
);

/**
 * @route   POST /change-password
 * @desc    Alteração autenticada de palavra-passe
 * @access  Privado (Exige autenticação JWT)
 */
router.post(
  '/change-password',
  authenticate,
  validateBody(changePasswordSchema),
  authController.changePassword
);

/**
 * @route   POST /logout
 * @desc    Encerramento formal de sessão ativa e revogação de tokens
 * @access  Privado (Exige autenticação JWT)
 */
router.post(
  '/logout',
  authenticate,
  authController.logout
);

/**
 * @route   GET /me
 * @desc    Consulta dos dados do utilizador com sessão ativa
 * @access  Privado (Exige autenticação JWT)
 */
router.get(
  '/me',
  authenticate,
  authController.getMe
);

module.exports = router;