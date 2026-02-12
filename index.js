const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch'); // Убедись, что node-fetch установлен

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==========================================
// 1. КОНФИГУРАЦИЯ И КЛЮЧИ
// ==========================================

const PUBLIC_VAPID_KEY = 'BOY5OXY2TLy2mrgrJKtpJx53RLAamrpHJ7GpuvHsaN2WKFcz8WHbwAeNEBgULGwkhTe6o0UR-FHqOjR2VbrpaaQ';
const PRIVATE_VAPID_KEY = 'RJkp_M-bEsQdFhNcQ49jsQhnwHg-_2nrC-RBuNJUIDs';

// Настройки HeroSMS
const HERO_API_KEY = '0eA49025bAc743e0d3df93f215fc70b7'; 
const HERO_URL = 'https://hero-sms.com/stubs/handler_api.php';

// Настройка библиотеки WebPush
webpush.setVapidDetails(
  'mailto:admin@neohub.com',
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

// Хранилище данных (в оперативной памяти)
let subscribers = [];
let lastSmsData = {}; 

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

/**
 * Отправляет Push-уведомление всем подписчикам
 * @param {string} title - Заголовок (например, номер телефона)
 * @param {string} body - Текст уведомления (например, код)
 */
const sendPushToAll = (title, body) => {
  if (subscribers.length === 0) return;

  const payload = JSON.stringify({
    title: title,
    body: body,
  });

  console.log(`📤 Push: [${title}] -> ${body}`);

  subscribers.forEach((sub, index) => {
    webpush.sendNotification(sub, payload).catch(err => {
      // Если устройство недоступно или отписалось (410 Gone, 404 Not Found)
      if (err.statusCode === 410 || err.statusCode === 404) {
        subscribers.splice(index, 1); // Удаляем из списка
        console.log('🗑 Удален неактивный подписчик');
      } else {
        console.error('Ошибка отправки:', err.message);
      }
    });
  });
};

/**
 * Основной цикл проверки SMS через HeroSMS API
 */
const checkSmsLoop = async () => {
  try {
    const url = `${HERO_URL}?api_key=${HERO_API_KEY}&action=getActiveActivations`;
    
    // Делаем запрос
    const response = await fetch(url);
    const text = await response.text(); 

    // Если номеров нет, API возвращает строку
    if (text === 'NO_ACTIVATIONS') return;

    // Пробуем парсить JSON
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        // Игнорируем ошибки парсинга, если это не валидный JSON
        return;
    }

    // Нормализация данных (API может вернуть объект или массив)
    let activations = [];
    if (data.activeActivations) {
      if (Array.isArray(data.activeActivations)) {
        activations = data.activeActivations;
      } else if (data.activeActivations.rows) {
        activations = data.activeActivations.rows;
      }
    }

    // Проходим по всем активным номерам
    activations.forEach(item => {
      const id = item.activationId;
      const codeRaw = item.smsCode;
      
      // HeroSMS иногда шлет код массивом, иногда строкой
      const finalCode = Array.isArray(codeRaw) ? codeRaw[0] : codeRaw;

      // Формируем красивый номер телефона для заголовка
      const phoneNumber = item.phoneNumber ? `+${item.phoneNumber}` : 'SMS Code';

      // ЛОГИКА ОТПРАВКИ:
      // Если код есть (не null) И мы этот код для этого ID еще не отправляли
      if (finalCode && lastSmsData[id] !== finalCode) {
        
        console.log(`🚀 НОВАЯ СМС! Tel: ${phoneNumber}, Code: ${finalCode}`);
        
        // Отправляем: Заголовок = Номер, Текст = Код
        sendPushToAll(phoneNumber, `Код: ${finalCode}`);
        
        // Запоминаем, что отправили
        lastSmsData[id] = finalCode;
      }
    });

  } catch (error) {
    console.error('Ошибка цикла проверки SMS:', error.message);
  }
};

// ==========================================
// 3. РОУТЫ СЕРВЕРА
// ==========================================

// Прием подписки от клиента
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  
  const exists = subscribers.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscribers.push(subscription);
    console.log(`✅ Новый подписчик. Всего: ${subscribers.length}`);
  }
  
  res.status(201).json({});
});

// Тестовая отправка (для отладки)
app.get('/test-push', (req, res) => {
  sendPushToAll('NEO Hub Test', 'Проверка связи!');
  res.json({ status: 'sent', subscribersCount: subscribers.length });
});

// --- ГЛАВНАЯ СТРАНИЦА (ДЛЯ UPTIMEROBOT) ---
// Это нужно, чтобы мониторинг видел статус 200 OK
app.get('/', (req, res) => {
  console.log('🤖 Ping from UptimeRobot!');
  res.send('NeoHub Server is active! 🚀');
});

// ==========================================
// 4. ЗАПУСК
// ==========================================

// Запускаем цикл проверки каждые 3 секунды
setInterval(checkSmsLoop, 3000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
