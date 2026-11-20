/**
 * ONEKIXIKILA — CLIENTE HTTP DE API (Vanilla JS / Browser)
 * Centraliza requisições assíncronas (fetch), injeção automática de tokens CSRF,
 * cabeçalhos de autenticação Bearer, gestão de sessão e tratamento padronizado de erros.
 */

(function (window) {
  'use strict';

  class ApiClient {
    /**
     * @param {object} [config={}]
     * @param {string} [config.baseUrl='/api/v1']
     */
    constructor(config = {}) {
      this.baseUrl = config.baseUrl || '/api/v1';
      this.csrfCookieName = '_csrf_onekixikila';
    }

    /**
     * Recupera o token de proteção CSRF a partir de meta tag ou de cookie do navegador.
     * @returns {string|null}
     */
    getCsrfToken() {
      // 1. Tenta recuperar da meta tag HTML no <head>
      const metaTag = document.querySelector('meta[name="csrf-token"]');
      if (metaTag && metaTag.getAttribute('content')) {
        return metaTag.getAttribute('content');
      }

      // 2. Tenta recuperar do input oculto padrão em formulários
      const inputEl = document.querySelector('input[name="_csrf"]');
      if (inputEl && inputEl.value) {
        return inputEl.value;
      }

      // 3. Tenta recuperar do cookie seguro do navegador
      const cookies = document.cookie ? document.cookie.split('; ') : [];
      for (let i = 0; i < cookies.length; i++) {
        const parts = cookies[i].split('=');
        if (parts[0] === this.csrfCookieName) {
          return decodeURIComponent(parts[1]);
        }
      }

      return null;
    }

    /**
     * Recupera o token de acesso JWT do armazenamento local, se existente.
     * @returns {string|null}
     */
    getAccessToken() {
      try {
        return window.localStorage.getItem('onekixikila_access_token') || null;
      } catch (e) {
        return null;
      }
    }

    /**
     * Persiste o token de acesso no armazenamento local do navegador.
     * @param {string} token
     */
    setAccessToken(token) {
      try {
        if (token) {
          window.localStorage.setItem('onekixikila_access_token', token);
        } else {
          window.localStorage.removeItem('onekixikila_access_token');
        }
      } catch (e) {
        // Ignora restrições de storage em modo de navegação anônima estrita
      }
    }

    /**
     * Remove todos os dados locais de sessão.
     */
    clearSession() {
      try {
        window.localStorage.removeItem('onekixikila_access_token');
        window.localStorage.removeItem('onekixikila_user');
      } catch (e) {}
    }

    /**
     * Monta os cabeçalhos HTTP padrão para a requisição.
     * @param {object} [customHeaders={}]
     * @param {boolean} [isFormData=false]
     * @returns {Headers}
     */
    buildHeaders(customHeaders = {}, isFormData = false) {
      const headers = new Headers();

      if (!isFormData) {
        headers.set('Content-Type', 'application/json');
      }
      headers.set('Accept', 'application/json');

      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
      }

      const accessToken = this.getAccessToken();
      if (accessToken) {
        headers.set('Authorization', 'Bearer ' + accessToken);
      }

      for (const key of Object.keys(customHeaders)) {
        if (customHeaders[key] !== undefined && customHeaders[key] !== null) {
          headers.set(key, customHeaders[key]);
        }
      }

      return headers;
    }

    /**
     * Executa a chamada HTTP subjacente via Fetch API com tratamento de erros.
     * @param {string} endpoint
     * @param {object} [options={}]
     * @returns {Promise<any>}
     */
    async request(endpoint, options = {}) {
      const isAbsolute = endpoint.startsWith('http://') || endpoint.startsWith('https://');
      const isApiRoot = endpoint.startsWith('/api/');
      const url = isAbsolute || isApiRoot ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

      const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
      const headers = this.buildHeaders(options.headers || {}, isFormData);

      const fetchOptions = {
        method: options.method || 'GET',
        headers,
        credentials: options.credentials || 'include'
      };

      if (options.body) {
        if (isFormData) {
          fetchOptions.body = options.body;
        } else if (typeof options.body === 'object') {
          fetchOptions.body = JSON.stringify(options.body);
        } else {
          fetchOptions.body = options.body;
        }
      }

      let response;
      try {
        response = await fetch(url, fetchOptions);
      } catch (networkError) {
        throw {
          status: 0,
          code: 'NETWORK_ERROR',
          message: 'Falha de comunicação com o servidor da OneKixikila. Verifique a sua ligação à internet.'
        };
      }

      let data = null;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          data = await response.json();
        } catch (jsonError) {
          data = null;
        }
      } else {
        const textResponse = await response.text();
        data = { message: textResponse };
      }

      if (!response.ok) {
        const errorDetails = data && data.error ? data.error : {};
        const parsedError = {
          status: response.status,
          code: errorDetails.code || (response.status === 401 ? 'AUTHENTICATION_REQUIRED' : 'HTTP_ERROR'),
          message: errorDetails.message || data.message || `Erro HTTP ${response.status}`,
          details: errorDetails.details || null
        };

        // Se a sessão expirou e não for a própria rota de login, desvia o utilizador
        if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
          this.clearSession();
          if (options.redirectOnUnauthorized !== false && !isApiRoot) {
            window.location.href = '/login?expired=1';
          }
        }

        throw parsedError;
      }

      return data;
    }

    /**
     * Executa requisição HTTP GET.
     * @param {string} endpoint
     * @param {object} [options={}]
     */
    async get(endpoint, options = {}) {
      return this.request(endpoint, { ...options, method: 'GET' });
    }

    /**
     * Executa requisição HTTP POST.
     * @param {string} endpoint
     * @param {object|FormData} [body]
     * @param {object} [options={}]
     */
    async post(endpoint, body = {}, options = {}) {
      return this.request(endpoint, { ...options, method: 'POST', body });
    }

    /**
     * Executa requisição HTTP PUT.
     * @param {string} endpoint
     * @param {object} [body]
     * @param {object} [options={}]
     */
    async put(endpoint, body = {}, options = {}) {
      return this.request(endpoint, { ...options, method: 'PUT', body });
    }

    /**
     * Executa requisição HTTP PATCH.
     * @param {string} endpoint
     * @param {object} [body]
     * @param {object} [options={}]
     */
    async patch(endpoint, body = {}, options = {}) {
      return this.request(endpoint, { ...options, method: 'PATCH', body });
    }

    /**
     * Executa requisição HTTP DELETE.
     * @param {string} endpoint
     * @param {object} [options={}]
     */
    async delete(endpoint, options = {}) {
      return this.request(endpoint, { ...options, method: 'DELETE' });
    }

    /**
     * Realiza upload de ficheiros multipart com cabeçalhos apropriados.
     * @param {string} endpoint
     * @param {FormData} formData
     * @param {object} [options={}]
     */
    async upload(endpoint, formData, options = {}) {
      return this.request(endpoint, {
        ...options,
        method: 'POST',
        body: formData
      });
    }
  }

  // Exportação global no escopo do navegador
  window.ApiClient = ApiClient;
  window.apiClient = new ApiClient();
})(typeof window !== 'undefined' ? window : this);