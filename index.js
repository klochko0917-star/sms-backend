const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // Убедись, что node-fetch установлен в package.json

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- 1. КЛЮЧИ PWA (Твои ключи) ---
const PUBLIC_VAPID_KEY = 'BOY5OXY2TLy2mrgrJKtpJx53RLAamrpHJ7GpuvHsaN2WKFcz8WHbwAeNEBgULGwkhTe6o0UR-FHqOjR2VbrpaaQ';
const PRIVATE_VAPID_KEY = 'RJkp_M-bEsQdFhNcQ49jsQhnwHg-_2nrC-RBuNJUIDs';

// --- 2. НАСТРОЙКИ HEROSMS ---
const HERO_API_KEY = '0eA49025bAc743e0d3df93f215fc70b7'; 
const HERO_URL = 'https://hero-sms.com/stubs/handler_api.php';

// Настраиваем web-push
webpush.setVapidDetails(
  'mailto:admin@neohub.com',
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

// Хранилище подписчиков (iPhone/Android)
let subscribers = [];

// Хранилище уже отправленных СМС, чтобы не спамить
let lastSmsData = {}; 

// --- РОУТЫ ---

// 1. Принимаем подписку от телефона
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  
  // Проверяем, нет ли уже такого подписчика
  const exists = subscribers.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscribers.push(subscription);
    console.log(`✅ Новый подписчик! Всего устройств: ${subscribers.length}`);
  }
  
  res.status(201).json({});
});

// 2. Тестовый роут (для проверки работы пушей вручную)
app.get('/test-push', (req, res) => {
  sendPushToAll('Это тестовое уведомление от NEO Hub!');
  res.json({ status: 'sent', count: subscribers.length });
});

// --- ЛОГИКА РАССЫЛКИ ---

const sendPushToAll = (text) => {
  if (subscribers.length === 0) return;

  const payload = JSON.stringify({
    title: 'NEO Hub',
    body: text,
    // icon: '/icon-192.png' // Можно добавить иконку
  });

  console.log(`📤 Отправляем пуш: "${text}" на ${subscribers.length} устройств`);

  subscribers.forEach((sub, index) => {
    webpush.sendNotification(sub, payload).catch(err => {
      // Если устройство отписалось или токен устарел - удаляем его
      if (err.statusCode === 410 || err.statusCode === 404) {
        console.log('🗑 Удаляем неактивного подписчика');
        subscribers.splice(index, 1); 
      } else {
        console.error('Ошибка отправки:', err.message);
      }
    });
  });
};

// --- ЛОГИКА ПРОВЕРКИ SMS (HEROSMS) ---

const checkSmsLoop = async () => {
  try {
    // Запрашиваем АКТИВНЫЕ активации
    const url = `${HERO_URL}?api_key=${HERO_API_KEY}&action=getActiveActivations`;
    
    const response = await fetch(url);
    const text = await response.text(); // Сначала берем текст, т.к. может прийти "NO_ACTIVATIONS"

    if (text === 'NO_ACTIVATIONS') {
       // Номеров нет, ничего не делаем
       return; 
    }

    // Пытаемся распарсить JSON
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        // Если пришла ошибка текстом (например BAD_KEY)
        if (!text.includes('NO_ACTIVATIONS')) {
            console.log('HeroSMS ответил странно:', text); 
        }
        return;
    }

    // Нормализуем данные (API может вернуть массив или объект)
    let activations = [];
    if (data.activeActivations) {
      if (Array.isArray(data.activeActivations)) {
        activations = data.activeActivations;
      } else if (data.activeActivations.rows) {
        activations = data.activeActivations.rows;
      }
    }

    // Проверяем каждый активный номер
    activations.forEach(item => {
      const id = item.activationId;
      const codeRaw = item.smsCode; // Может быть массив или строка
      
      // Берем код (если это массив, то первый элемент)
      const finalCode = Array.isArray(codeRaw) ? codeRaw[0] : codeRaw;
      const smsText = item.smsText || item.text || '';

      // ГЛАВНОЕ УСЛОВИЕ: Код есть И мы его еще не видели для этого ID
      if (finalCode && lastSmsData[id] !== finalCode) {
        
        console.log(`🚀 ПОЙМАЛИ КОД! ID: ${id}, Code: ${finalCode}`);
        
        // Отправляем пуш
        sendPushToAll(`Код: ${finalCode}`);
        
        // Запоминаем, чтобы не отправлять повторно
        lastSmsData[id] = finalCode;
      }
    });

  } catch (error) {
    console.error('Ошибка в цикле проверки:', error.message);
  }
};

// Запускаем проверку каждые 3 секунды
setInterval(checkSmsLoop, 3000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
