// heroApiServer.js
const axios = require('axios');

const API_KEY = '0eA49025bAc743e0d3df93f215fc70b7';
const BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';

const parseResponse = (text) => {
  if (!text) return { status: 'EMPTY', error: 'Empty Response' };
  if (typeof text === 'object') return { status: 'JSON', value: text };

  const raw = String(text).trim();
  if (raw === 'NO_NUMBERS') return { status: 'NO_NUMBERS', error: 'Нет номеров' };
  if (raw === 'NO_BALANCE') return { status: 'NO_BALANCE', error: 'Пополните баланс' };
  if (raw.includes('BAD_KEY')) return { status: 'BAD_KEY', error: 'Неверный ключ API' };

  const parts = raw.split(':');
  const status = parts[0] || 'UNKNOWN';
  const value = parts.length > 1 ? parts[1] : null;
  const extra = parts.length > 2 ? parts.slice(2).join(':') : null;

  return { status, value, extra, raw };
};

const heroApiServer = {
  // Проверка статуса активации
  getStatus: async (id) => {
    try {
      const { data } = await axios.get(BASE_URL, {
        params: { api_key: API_KEY, action: 'getStatus', id },
        timeout: 5000
      });
      
      const parsed = parseResponse(data);
      
      if (parsed.status === 'STATUS_OK') {
        return { code: parsed.value, text: parsed.extra || null };
      }
      if (parsed.status === 'STATUS_WAIT_CODE') return { status: 'WAIT' };
      if (parsed.status === 'STATUS_CANCEL') return { status: 'CANCELLED' };
      
      return { status: 'UNKNOWN' };
    } catch (e) {
      console.error(`[API ERROR] getStatus(${id}):`, e.message);
      return { status: 'ERROR' };
    }
  },

  // Подтверждение получения SMS
  setStatus: async (id, status) => {
    try {
      await axios.get(BASE_URL, {
        params: { api_key: API_KEY, action: 'setStatus', id, status },
        timeout: 5000
      });
    } catch (e) {
      console.error(`[API ERROR] setStatus(${id}, ${status}):`, e.message);
    }
  },

  // Получить список активных (для получения полного текста SMS)
  getCurrentActivations: async () => {
    try {
      const { data } = await axios.get(BASE_URL, {
        params: { 
          api_key: API_KEY, 
          action: 'getActiveActivations',
          limit: 100
        },
        timeout: 5000
      });

      if (data === 'NO_ACTIVATIONS') return [];

      let items = [];
      if (Array.isArray(data.activeActivations)) {
        items = data.activeActivations;
      } else if (data.activeActivations?.rows) {
        items = data.activeActivations.rows;
      } else if (data.activeActivations?.row) {
        items = [data.activeActivations.row];
      }

      return items.map(item => ({
        id: item.activationId,
        phoneNumber: item.phoneNumber,
        serviceName: item.serviceCode || 'Unknown',
        smsCode: (item.smsCode && Array.isArray(item.smsCode)) ? item.smsCode[0] : item.smsCode,
        smsText: item.smsText || item.text || null
      }));
    } catch (e) {
      console.error('[API ERROR] getCurrentActivations:', e.message);
      return [];
    }
  }
};

module.exports = heroApiServer;
