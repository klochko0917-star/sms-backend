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

// === ИЗМЕНЕНИЕ: Хранилище теперь умное ===
// Было: let subscribers = [];
// Стало: Объект клиентов по ID
// Формат: { 'user_123': { subscription: {...}, watchedIds: ['1001', '1002'] } }
let clients = {};

// Хранилище уже отправленных СМС
let lastSmsData = {}; 

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

/**
 * Отправляет Push-уведомление КОНКРЕТНОМУ подписчику
 */
const sendPushToClient = (subscription, title, body) => {
  const payload = JSON.stringify({
    title: title,
    body: body,
  });

  console.log(`📤 Push (Personal): [${title}] -> ${body}`);

  webpush.sendNotification(subscription, payload).catch(err => {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log('💀 Подписка неактивна (клиент удален)');
    } else {
      console.error('Ошибка отправки:', err.message);
    }
  });
};

/**
 * Основной цикл проверки SMS через HeroSMS API
 */
const checkSmsLoop = async () => {
  try {
    const url = `${HERO_URL}?api_key=${HERO_API_KEY}&action=getActiveActivations`;
    
    const response = await fetch(url);
    const text = await response.text(); 

    if (text === 'NO_ACTIVATIONS') return;

    let data;
    try { data = JSON.parse(text); } catch (e) { return; }

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
      const id = String(item.activationId); // ID активации
      const codeRaw = item.smsCode;
      
      const finalCode = Array.isArray(codeRaw) ? codeRaw[0] : codeRaw;
      const phoneNumber = item.phoneNumber ? `+${item.phoneNumber}` : 'SMS Code';

      // ЛОГИКА: Если пришел НОВЫЙ код
      if (finalCode && lastSmsData[id] !== finalCode) {
        
        console.log(`🚀 НОВАЯ СМС! ID: ${id}, Tel: ${phoneNumber}, Code: ${finalCode}`);
        
        // --- ИЩЕМ, ЧЕЙ ЭТО НОМЕР ---
        let foundOwner = false;

        Object.keys(clients).forEach(clientId => {
          const client = clients[clientId];
          
          // Проверяем: есть ли этот ID номера в списке "слежения" у клиента?
          if (client.watchedIds && client.watchedIds.includes(id)) {
            // НАШЛИ ВЛАДЕЛЬЦА! Шлем только ему.
            sendPushToClient(client.subscription, phoneNumber, `Код: ${finalCode}`);
            foundOwner = true;
          }
        });

        if (!foundOwner) {
          console.log(`⚠️ Владелец номера ${id} не найден онлайн. Уведомление не отправлено.`);
        }
        
        // Запоминаем, что код обработали
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

// 1. ПОДПИСКА (Теперь принимаем и clientId)
app.post('/subscribe', (req, res) => {
  const { subscription, clientId } = req.body;
  
  if (!clientId || !subscription) {
    return res.status(400).json({ error: 'Missing data' });
  }

  // Если клиента нет - создаем, если есть - обновляем подписку
  if (!clients[clientId]) {
    clients[clientId] = { subscription, watchedIds: [] };
    console.log(`✅ Новый клиент зарегистрирован: ${clientId}`);
  } else {
    clients[clientId].subscription = subscription;
    console.log(`🔄 Обновлена подписка для: ${clientId}`);
  }
  
  res.status(201).json({});
});

// 2. HEARTBEAT (Сердцебиение) - Клиент присылает список СВОИХ номеров
// Этот роут нужно вызывать с фронтенда каждые 3-5 секунд
app.post('/heartbeat', (req, res) => {
  const { clientId, myActiveIds } = req.body;

  if (clients[clientId]) {
    // Обновляем список номеров, которые "слушает" этот клиент
    clients[clientId].watchedIds = myActiveIds || [];
    // console.log(`💓 Heartbeat ${clientId}: следит за ${clients[clientId].watchedIds.length} номерами`);
  }

  res.json({ status: 'ok' });
});

// 3. Тестовая отправка (шлет ВСЕМ подключенным, для проверки)
app.get('/test-push', (req, res) => {
  const count = Object.keys(clients).length;
  Object.values(clients).forEach(client => {
    sendPushToClient(client.subscription, 'NEO Hub', 'Тестовое уведомление (Личное)');
  });
  res.json({ status: 'sent', clientsCount: count });
});

// 4. ГЛАВНАЯ СТРАНИЦА (ДЛЯ UPTIMEROBOT)
app.get('/', (req, res) => {
  console.log('🤖 Ping from UptimeRobot!');
  res.send('NeoHub Smart Server is active! 🚀');
});

// ==========================================
// 4. ЗАПУСК
// ==========================================

setInterval(checkSmsLoop, 3000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
