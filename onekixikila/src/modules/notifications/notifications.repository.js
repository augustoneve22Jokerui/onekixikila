const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `notifications`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para inserção de mensagens na fila,
 * marcação de leitura, consulta paginada de notificações recebidas e contagem de itens não lidos.
 */
class NotificationsRepository {
  /**
   * Insere um novo registo de notificação na base de dados.
   *
   * @param {object} params
   * @param {string} params.userId - UUID do utilizador destinatário
   * @param {string} params.title - Título resumido da notificação
   * @param {string} params.message - Mensagem completa
   * @param {string} params.eventType - Tipo canónico do evento (ex: 'CONTRIBUTION_DUE_ALERT')
   * @param {string} [params.channel='IN_APP'] - 'IN_APP', 'EMAIL', 'SMS', 'PUSH'
   * @param {string} [params.status='PENDING'] - 'PENDING', 'SENT', 'DELIVERED', 'READ'
   * @param {object} [params.payload={}] - Metadados estruturados
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createNotification(params, client = null) {
    const {
      userId,
      title,
      message,
      eventType,
      channel = 'IN_APP',
      status = 'PENDING',
      payload = {}
    } = params;

    const text = `
      INSERT INTO notifications (
        user_id,
        title,
        message,
        event_type,
        channel,
        status,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING *;
    `;

    const values = [
      userId,
      title,
      message,
      eventType,
      channel,
      status,
      JSON.stringify(payload)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma notificação pelo seu identificador primário UUID.
   *
   * @param {string} notificationId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(notificationId, client = null) {
    const text = `
      SELECT 
        id,
        user_id,
        title,
        message,
        event_type,
        channel,
        status,
        payload,
        is_read,
        read_at,
        sent_at,
        failure_reason,
        retry_count,
        created_at,
        updated_at
      FROM notifications
      WHERE id = $1;
    `;

    return client ? queryOneClient(client, text, [notificationId]) : queryOne(text, [notificationId]);
  }

  /**
   * Marca uma notificação individual como lida pelo destinatário.
   *
   * @param {string} notificationId
   * @param {import('pg').PoolClient} [client]
   */
  async markAsRead(notificationId, client = null) {
    const text = `
      UPDATE notifications
      SET is_read = TRUE,
          read_at = NOW() AT TIME ZONE 'UTC',
          status = 'READ',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, [notificationId]) : queryOne(text, [notificationId]);
  }

  /**
   * Marca todas as notificações pendentes de um utilizador como lidas em lote.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Quantidade de notificações atualizadas
   */
  async markAllAsRead(userId, client = null) {
    const text = `
      UPDATE notifications
      SET is_read = TRUE,
          read_at = NOW() AT TIME ZONE 'UTC',
          status = 'READ',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $1 AND is_read = FALSE;
    `;

    const result = client ? await queryClient(client, text, [userId]) : await query(text, [userId]);
    return result.rowCount;
  }

  /**
   * Conta a quantidade total de notificações não lidas de um utilizador.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async countUnread(userId, client = null) {
    const text = `
      SELECT COUNT(*)::integer AS unread_count
      FROM notifications
      WHERE user_id = $1 AND is_read = FALSE;
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);
    return result ? result.unread_count : 0;
  }

  /**
   * Consulta a lista paginada de notificações de um utilizador com filtros opcionais.
   *
   * @param {string} userId
   * @param {object} [filters={}] - { isRead, channel, eventType }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserNotifications(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.isRead !== undefined) {
      conditions.push(`is_read = $${paramIndex}`);
      values.push(filters.isRead);
      paramIndex += 1;
    }

    if (filters.channel) {
      conditions.push(`channel = $${paramIndex}`);
      values.push(filters.channel);
      paramIndex += 1;
    }

    if (filters.eventType) {
      conditions.push(`event_type = $${paramIndex}`);
      values.push(filters.eventType);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM notifications
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // Linhas paginadas
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        id,
        user_id,
        title,
        message,
        event_type,
        channel,
        status,
        payload,
        is_read,
        read_at,
        created_at
      FROM notifications
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de notificações
const notificationsRepository = new NotificationsRepository();

module.exports = notificationsRepository;