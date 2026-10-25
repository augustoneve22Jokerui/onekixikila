/**
 * Catálogo canónico de papéis e hierarquias de utilizadores na plataforma OneKixikila.
 * Sincronizado estritamente com os tipos enumerados SQL definidos nas migrações 002 e 006.
 */

// Papéis globais da plataforma (Tabela `users`, coluna `role`)
const USER_ROLES = Object.freeze({
  USER: 'USER',                                 // Utilizador registado com perfil básico
  MEMBER: 'MEMBER',                             // Membro participante ativo em grupos de Kixikila
  GROUP_LEADER: 'GROUP_LEADER',                 // Líder/criador com gestão de grupos
  MODERATOR: 'MODERATOR',                       // Moderador comunitário e de denúncias no chat
  SUPPORT_AGENT: 'SUPPORT_AGENT',               // Agente de suporte técnico e atendimento
  AUDITOR: 'AUDITOR',                           // Auditor financeiro e de conformidade regulatória
  ADMIN: 'ADMIN',                               // Administrador geral do ecossistema
  FINANCIAL_OPERATOR: 'FINANCIAL_OPERATOR'     // Operador de tesouraria e conciliação bancária
});

// Papéis de filiação interna no contexto de grupos de Kixikila (`group_memberships`)
const GROUP_MEMBER_ROLES = Object.freeze({
  MEMBER: 'MEMBER',                             // Participante regular
  VICE_LEADER: 'VICE_LEADER',                   // Vice-líder com poderes de moderação delegados
  TREASURER: 'TREASURER',                       // Apoio ao acompanhamento das contribuições
  SECRETARY: 'SECRETARY'                        // Apoio administrativo e comunicação
});

// Papéis de mandato formal de liderança (`leadership_assignments`)
const LEADERSHIP_ROLES = Object.freeze({
  PRIMARY_LEADER: 'PRIMARY_LEADER',             // Líder titular fundador do grupo
  VICE_LEADER: 'VICE_LEADER',                   // Vice-líder homologado
  ACTING_LEADER: 'ACTING_LEADER'                // Líder interino em períodos de ausência ou sucessão
});

// Lista plana para validações de schema e restrições
const ALL_USER_ROLES = Object.freeze(Object.values(USER_ROLES));
const ALL_GROUP_MEMBER_ROLES = Object.freeze(Object.values(GROUP_MEMBER_ROLES));
const ALL_LEADERSHIP_ROLES = Object.freeze(Object.values(LEADERSHIP_ROLES));

// Níveis hierárquicos de acesso administrativo
const ADMINISTRATIVE_ROLES = Object.freeze([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.FINANCIAL_OPERATOR,
  USER_ROLES.SUPPORT_AGENT
]);

/**
 * Valida se um papel informado pertence aos papéis de utilizador autorizados.
 * @param {string} role
 * @returns {boolean}
 */
const isValidUserRole = (role) => {
  return typeof role === 'string' && ALL_USER_ROLES.includes(role);
};

/**
 * Valida se um papel informado pertence aos papéis de membro de grupo.
 * @param {string} role
 * @returns {boolean}
 */
const isValidGroupMemberRole = (role) => {
  return typeof role === 'string' && ALL_GROUP_MEMBER_ROLES.includes(role);
};

module.exports = {
  USER_ROLES,
  GROUP_MEMBER_ROLES,
  LEADERSHIP_ROLES,
  ALL_USER_ROLES,
  ALL_GROUP_MEMBER_ROLES,
  ALL_LEADERSHIP_ROLES,
  ADMINISTRATIVE_ROLES,
  isValidUserRole,
  isValidGroupMemberRole
};