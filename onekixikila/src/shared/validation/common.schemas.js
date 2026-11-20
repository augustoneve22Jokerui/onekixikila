const { z } = require('zod');
const { ALL_CURRENCY_CODES, DEFAULT_CURRENCY } = require('../constants/currencies');
const {
  sanitizePhoneNumber,
  sanitizeNationalId,
  sanitizeIban,
  stripControlChars
} = require('../security/sanitize');

/**
 * Esquema de validação para identificadores únicos universais (UUID v4).
 */
const uuidSchema = z
  .string({ required_error: 'Identificador UUID é obrigatório.' })
  .uuid({ message: 'Identificador deve ser um UUID v4 válido.' });

/**
 * Esquema de validação para endereços de e-mail com normalização em minúsculas.
 */
const emailSchema = z
  .string({ required_error: 'O endereço de e-mail é obrigatório.' })
  .trim()
  .toLowerCase()
  .email({ message: 'O endereço de e-mail fornecido é inválido.' })
  .max(150, { message: 'O e-mail não pode exceder 150 caracteres.' });

/**
 * Esquema para números de telemóvel no padrão de Angola (+244 9XX XXX XXX).
 * Transforma e normaliza para o formato internacional canónico.
 */
const angolanPhoneSchema = z
  .string({ required_error: 'O número de telemóvel é obrigatório.' })
  .trim()
  .refine(
    (val) => {
      const sanitized = sanitizePhoneNumber(val);
      return sanitized !== null;
    },
    { message: 'Número de telefone inválido. Insira um número angolano válido (ex: 923 000 000 ou +244923000000).' }
  )
  .transform((val) => sanitizePhoneNumber(val));

/**
 * Esquema para palavras-passe fortes.
 * Exige no mínimo 8 caracteres, com letra maiúscula, letra minúscula, número e caractere especial.
 */
const passwordSchema = z
  .string({ required_error: 'A palavra-passe é obrigatória.' })
  .min(8, { message: 'A palavra-passe deve conter pelo menos 8 caracteres.' })
  .max(128, { message: 'A palavra-passe não pode exceder 128 caracteres.' })
  .regex(/[A-Z]/, { message: 'A palavra-passe deve conter pelo menos uma letra maiúscula.' })
  .regex(/[a-z]/, { message: 'A palavra-passe deve conter pelo menos uma letra minúscula.' })
  .regex(/\d/, { message: 'A palavra-passe deve conter pelo menos um número.' })
  .regex(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, {
    message: 'A palavra-passe deve conter pelo menos um caractere especial (!@#$%^&*...).'
  });

/**
 * Esquema para o Bilhete de Identidade (BI) nacional de Angola.
 * Padrão: 9 dígitos + 2 letras da província + 3 dígitos (ex: 005432100LA045).
 */
const angolanNationalIdSchema = z
  .string({ required_error: 'O número do Bilhete de Identidade é obrigatório.' })
  .trim()
  .transform((val) => sanitizeNationalId(val))
  .refine(
    (val) => /^\d{9}[A-Z]{2}\d{3}$/.test(val),
    { message: 'Formato de Bilhete de Identidade angolano inválido. Padrão esperado: 9 dígitos, 2 letras e 3 dígitos.' }
  );

/**
 * Esquema para IBAN bancário de Angola (AO06 + 21 dígitos).
 */
const angolanIbanSchema = z
  .string({ required_error: 'O IBAN bancário é obrigatório.' })
  .trim()
  .transform((val) => sanitizeIban(val))
  .refine(
    (val) => /^AO06\d{21}$/.test(val),
    { message: 'IBAN bancário angolano inválido. Deve iniciar por AO06 seguido de 21 dígitos numéricos.' }
  );

/**
 * Esquema para código ISO de moeda suportada (padrão AOA).
 */
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(
    (val) => ALL_CURRENCY_CODES.includes(val),
    { message: `Código de moeda não suportado. Moedas aceites: ${ALL_CURRENCY_CODES.join(', ')}.` }
  )
  .default(DEFAULT_CURRENCY);

/**
 * Esquema para montantes financeiros inteiros em Kwanzas (AOA).
 * Rejeita números de ponto flutuante, valores negativos ou inferiores ao mínimo de 100 Kz.
 */
const moneyAmountSchema = z
  .coerce.number({ required_error: 'O montante financeiro é obrigatório.' })
  .int({ message: 'O montante deve ser um número inteiro de Kwanzas (sem cêntimos fracionários).' })
  .positive({ message: 'O montante deve ser estritamente superior a zero.' })
  .min(100, { message: 'O montante mínimo de operação é de 100 Kz.' })
  .max(50000000, { message: 'O montante máximo por operação é de 50.000.000 Kz.' });

/**
 * Esquema para chaves de idempotência em transações financeiras.
 */
const idempotencyKeySchema = z
  .string({ required_error: 'A chave de idempotência é obrigatória.' })
  .trim()
  .min(8, { message: 'A chave de idempotência deve conter pelo menos 8 caracteres.' })
  .max(120, { message: 'A chave de idempotência não pode exceder 120 caracteres.' })
  .regex(/^[A-Za-z0-9_\-:]{8,120}$/, {
    message: 'Chave de idempotência contém caracteres inválidos. Utilize apenas alfanuméricos, hifens e underscores.'
  });

/**
 * Esquema para slugs de identificação de URL de grupos.
 */
const slugSchema = z
  .string({ required_error: 'O identificador slug é obrigatório.' })
  .trim()
  .min(3, { message: 'O slug deve conter no mínimo 3 caracteres.' })
  .max(180, { message: 'O slug não pode exceder 180 caracteres.' })
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'O slug deve conter apenas letras minúsculas, números e hifens não consecutivos.'
  });

/**
 * Esquema de validação para textos seguros (títulos, mensagens e descrições),
 * expurgando caracteres de controlo invisíveis.
 */
const safeTextSchema = (maxLength = 255) =>
  z
    .string({ required_error: 'Texto obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length > 0, { message: 'O campo de texto não pode estar vazio.' })
    .refine((val) => val.length <= maxLength, { message: `O texto não pode exceder ${maxLength} caracteres.` });

/**
 * Esquema de validação para coordenadas geográficas aproximadas.
 */
const coordinatesSchema = z.object({
  latitude: z
    .coerce.number()
    .min(-90, { message: 'Latitude mínima permitida é -90.' })
    .max(90, { message: 'Latitude máxima permitida é 90.' }),
  longitude: z
    .coerce.number()
    .min(-180, { message: 'Longitude mínima permitida é -180.' })
    .max(180, { message: 'Longitude máxima permitida é 180.' })
});

module.exports = {
  uuidSchema,
  emailSchema,
  angolanPhoneSchema,
  passwordSchema,
  angolanNationalIdSchema,
  angolanIbanSchema,
  currencySchema,
  moneyAmountSchema,
  idempotencyKeySchema,
  slugSchema,
  safeTextSchema,
  coordinatesSchema
};