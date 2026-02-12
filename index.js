const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- ТВОИ КЛЮЧИ (Я ИХ УЖЕ ВСТАВИЛ) ---
const PUBLIC_VAPID_KEY = 'BOY5OXY2TLy2mrgrJKtpJx53RLAamrpHJ7GpuvHsaN2WKFcz8WHbwAeNEBgULGwkhTe6o0UR-FHqOjR2VbrpaaQ';
const PRIVATE_VAPID_KEY = 'RJkp_M-bEsQdFhNcQ49jsQhnwHg-_2nrC-RBuNJUIDs';

// --- НАСТРОЙКИ СЕРВИСА SMS ---
const SMS_SERVICE_API_KEY = 'ТВОЙ_API_KEY_ОТ_5SIM_ИЛИ_SMS_ACTIVATE'; 
// Пример URL (замени на реальный метод своего сервиса!)
const SMS_API_URL = `https://api.sms-service.com/stubs/handler_api.php?api_key=${SMS_SERVICE_API_KEY}&action=getActiveActivations`;

// Настраиваем web-push
webpush.setVapidDetails(
  'mailto:admin@neohub.com',
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

// Хранилище подписчиков (в памяти)
let subscribers = [];

// 1. Принимаем подписку от телефона
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  
  // Сохраняем, если такой еще нет
  const exists = subscribers.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscribers.push(subscription);
    console.log('✅ Новый iPhone подписался! Всего:', subscribers.length);
  }
  
  res.status(201).json({});
});

// 2. Функция рассылки всем
const sendPushToAll = (text) => {
  const payload = JSON.stringify({
    title: 'NEO Hub',
    body: text,
  });

  subscribers.forEach((sub, index) => {
    webpush.sendNotification(sub, payload).catch(err => {
      console.error('Ошибка отправки:', err);
      if (err.statusCode === 410 || err.statusCode === 404) {
        subscribers.splice(index, 1); // Удаляем мертвую подписку
      }
    });
  });
};

// 3. Робот, который проверяет SMS каждые 5 сек
let lastSmsData = {}; 

const checkSmsLoop = async () => {
  try {
    // Делаем запрос к API сервиса
    // ВАЖНО: Убедись, что твой сервис возвращает JSON. Если текст - надо парсить.
    const response = await fetch(SMS_API_URL);
    const data = await response.json(); 

    if (Array.isArray(data)) {
      data.forEach(activation => {
        // Если пришел код И он новый
        if (activation.smsText && lastSmsData[activation.id] !== activation.smsText) {
          console.log(`📩 Новая SMS: ${activation.smsText}`);
          
          // ОТПРАВЛЯЕМ ПУШ
          sendPushToAll(`Код: ${activation.smsCode || 'Получен'}\n${activation.smsText}`);
          
          lastSmsData[activation.id] = activation.smsText;
        }
      });
    }
  } catch (error) {
    // console.error('Ошибка API (игнорируем):', error.message);
  }
};

// Запуск цикла проверки
setInterval(checkSmsLoop, 5000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
