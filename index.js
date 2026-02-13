const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const PNF = require('google-libphonenumber').PhoneNumberFormat;
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();

// ✅ ПОДКЛЮЧАЕМ НАШ НОВЫЙ МОДУЛЬ API
const heroApiServer = require('./heroApiServer');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==========================================
// 1. НАСТРОЙКА FIREBASE
// ==========================================

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ [SYSTEM] Ключи Firebase загружены из ENV.");
  } catch (e) {
    console.error('❌ [SYSTEM] ОШИБКА JSON в ENV переменной!', e);
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log("⚠️ [SYSTEM] Ключи загружены из локального файла.");
  } catch (e) {
    console.error('❌ [SYSTEM] Ключи не найдены.');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sms-history-3c45e-default-rtdb.europe-west1.firebasedatabase.app/"
});

const db = admin.database();

// ==========================================
// 2. НАСТРОЙКА WEB PUSH
// ==========================================

const PUBLIC_VAPID_KEY = process.env.PUBLIC_VAPID_KEY || 'BOY5OXY2TLy2mrgrJKtpJx53RLAamrpHJ7GpuvHsaN2WKFcz8WHbwAeNEBgULGwkhTe6o0UR-FHqOjR2VbrpaaQ';
const PRIVATE_VAPID_KEY = process.env.PRIVATE_VAPID_KEY || 'RJkp_M-bEsQdFhNcQ49jsQhnwHg-_2nrC-RBuNJUIDs';

webpush.setVapidDetails(
  'mailto:admin@neohub.com',
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

// ==========================================
// 3. УТИЛИТА ФОРМАТИРОВАНИЯ
// ==========================================

function formatPhoneNumber(rawNumber) {
  if (!rawNumber) return 'Неизвестный номер';
  
  let numberToParse = String(rawNumber);
  if (!numberToParse.startsWith('+')) {
      numberToParse = '+' + numberToParse;
  }

  try {
    const number = phoneUtil.parseAndKeepRawInput(numberToParse);
    return phoneUtil.format(number, PNF.INTERNATIONAL); 
  } catch (e) {
    return numberToParse;
  }
}

// ==========================================
// 4. СИСТЕМА ACTIVE POLLING (НОВАЯ ФУНКЦИОНАЛЬНОСТЬ)
// ==========================================

// Хранилище активных таймеров: { activationId: intervalId }
const activePollers = new Map();

// --- ЗАПУСК ОТСЛЕЖИВАНИЯ ---
function startPolling(activationId, data) {
  // Защита от дублей: если уже следим, выходим
  if (activePollers.has(activationId)) return;

  const startTime = data.createdAt || Date.now();
  const LIFE_TIME_MS = 20 * 60 * 1000; // 20 минут жизни заказа
  const formattedPhone = formatPhoneNumber(data.phoneNumber);

  console.log(`🔍 [POLLING START] Начинаю следить за ID: ${activationId} (${formattedPhone})`);

  const intervalId = setInterval(async () => {
    // 1. Проверяем время жизни
    const elapsed = Date.now() - startTime;
    if (elapsed > LIFE_TIME_MS) {
      console.log(`⏰ [POLLING TIMEOUT] ID: ${activationId} — время истекло. Остановка.`);
      stopPolling(activationId);
      return;
    }

    try {
      // 2. Запрос к провайдеру (API)
      const res = await heroApiServer.getStatus(activationId);

      // 3. Если статус "Отменен"
      if (res.status === 'CANCELLED' || res.status === '8') {
        console.log(`❌ [POLLING STOP] ID: ${activationId} — отменен на сервисе.`);
        stopPolling(activationId);
        // Можно также удалить из Firebase, если нужно:
        // db.ref(`activations/${activationId}`).remove();
        return;
      }

      // 4. Если пришел КОД
      if (res.code) {
        const incomingCode = String(res.code);
        
        // 4.1 Проверяем, есть ли этот код уже в базе (чтобы не писать зря)
        // Используем once(), чтобы просто проверить
        const msgRef = db.ref(`activations/${activationId}/messages/${incomingCode}`);
        const snapshot = await msgRef.once('value');

        if (snapshot.exists()) {
          // Код уже есть, ничего делать не надо, клиент или предыдущий тик уже сохранил
          // console.log(`💤 [POLLING] ID: ${activationId} — код ${incomingCode} уже обработан.`);
          return;
        }

        console.log(`⚡ [POLLING HIT] ID: ${activationId} — НАЙДЕН НОВЫЙ КОД: ${incomingCode}`);

        // 4.2 Получаем текст (если его нет в ответе getStatus, пробуем getActivations)
        let textToSave = res.text;
        if (!textToSave) {
          try {
             // Пытаемся достать текст из общего списка
             const list = await heroApiServer.getCurrentActivations();
             const item = list.find(i => String(i.id) === String(activationId));
             if (item && item.smsText) textToSave = item.smsText;
          } catch(err) {
             console.error(`⚠️ [POLLING TEXT ERROR] ${err.message}`);
          }
        }
        
        const finalText = textToSave || 'No text';

        // 4.3 СОХРАНЯЕМ В FIREBASE
        // Это действие триггернет Listener "child_changed" ниже, который и отправит ПУШ!
        await msgRef.set({
          code: incomingCode,
          text: finalText,
          serviceCode: data.serviceName || 'unknown',
          timestamp: Date.now(),
          pushSent: false,  // ВАЖНО: флаг false заставит Listener отправить пуш
          source: 'server_polling' // Метка для отладки
        });

        console.log(`💾 [POLLING SAVED] Код сохранен в базу. Ожидаем отправку пуша...`);

        // 4.4 Подтверждаем получение провайдеру (Status 3 - завершить/принять)
        // Важно: если нужно ждать ВТОРОЙ код, здесь логику нужно менять.
        // Но обычно ставим статус 3 (получил код).
        await heroApiServer.setStatus(activationId, 3);
      }

    } catch (err) {
      console.error(`⚠️ [POLLING ERROR] ID: ${activationId}: ${err.message}`);
    }

  }, 3000); // <-- ПРОВЕРКА КАЖДЫЕ 3 СЕКУНДЫ

  activePollers.set(activationId, intervalId);
}

// --- ОСТАНОВКА ОТСЛЕЖИВАНИЯ ---
function stopPolling(activationId) {
  const intervalId = activePollers.get(activationId);
  if (intervalId) {
    clearInterval(intervalId);
    activePollers.delete(activationId);
    console.log(`🛑 [POLLING STOPPED] ID: ${activationId} удален из мониторинга.`);
  }
}

// ==========================================
// 5. ЛОГИКА СЛУШАТЕЛЯ (MEGA LOGS + POLLING TRIGGER)
// ==========================================

const ref = db.ref('activations');

console.log('👀 [WATCHTOWER] Сервер запущен. Мониторинг базы в реальном времени...');
console.log('🔄 [SYSTEM] Инициализация polling-сервиса...');

// --- ИНИЦИАЛИЗАЦИЯ: Восстанавливаем слежку после рестарта сервера ---
ref.once('value', (snapshot) => {
  const allData = snapshot.val();
  if (!allData) {
    console.log('📭 [STARTUP] База пуста, ожидаю заказы.');
    return;
  }
  
  let count = 0;
  Object.keys(allData).forEach(key => {
    const data = allData[key];
    // Проверяем, не протух ли заказ (20 мин)
    const created = data.createdAt || Date.now();
    if (Date.now() - created < 20 * 60 * 1000) {
      startPolling(key, data);
      count++;
    }
  });
  console.log(`📊 [STARTUP] Восстановлено наблюдение за ${count} активными номерами.`);
});


// --- ЛОГЕР 1: НОВЫЙ ЗАКАЗ + ЗАПУСК POLLING ---
ref.on('child_added', (snapshot) => {
  const id = snapshot.key;
  const data = snapshot.val();
  
  const hasToken = !!data.pushSubscription;
  const rawPhone = data.phoneNumber || '???';
  const formattedPhone = formatPhoneNumber(rawPhone);
  const service = data.serviceName || 'Unknown Service';

  console.log(`\n🟢 [NEW ACTIVATION] ---------------------------------------`);
  console.log(`   🆔 ID: ${id}`);
  console.log(`   📱 Tel: ${formattedPhone} (${service})`);
  console.log(`   🔔 Push Token: ${hasToken ? '✅ CONNECTED' : '❌ MISSING'}`);
  console.log(`-----------------------------------------------------------\n`);

  // ✅ ГЛАВНОЕ ИЗМЕНЕНИЕ: Включаем слежку сервером
  startPolling(id, data);
});

// --- ЛОГЕР 2: УДАЛЕНИЕ ЗАКАЗА + ОСТАНОВКА POLLING ---
ref.on('child_removed', (snapshot) => {
  const id = snapshot.key;
  const data = snapshot.val();
  const rawPhone = data.phoneNumber || '???';
  
  console.log(`🔴 [REMOVED] Заказ ${id} (${formatPhoneNumber(rawPhone)}) удален из базы.\n`);

  // ✅ ГЛАВНОЕ ИЗМЕНЕНИЕ: Выключаем слежку
  stopPolling(id);
});

// --- ЛОГЕР 3: ИЗМЕНЕНИЯ (ОТПРАВКА PUSH) ---
// Этот код срабатывает и когда клиент пишет в базу, И когда сервер (через polling) пишет в базу
ref.on('child_changed', (snapshot) => {
  const activationId = snapshot.key;
  const data = snapshot.val();
  
  // 1. Проверка подписки
  if (!data.pushSubscription) {
    if (data.messages) {
       // console.log(`⚠️ [SKIP] ID: ${activationId} получил СМС, но нет токена.`);
    }
    return;
  }

  if (!data.messages) return;

  const messages = data.messages;
  const subscription = data.pushSubscription;
  
  const rawPhone = data.phoneNumber;
  const titleText = rawPhone ? formatPhoneNumber(rawPhone) : (data.serviceName || 'Новое СМС');

  Object.keys(messages).forEach(msgKey => {
    const message = messages[msgKey];
    
    // Если уже отправлено - молчим
    if (message.pushSent) return;

    // --- ЛОГИРОВАНИЕ СМС ---
    console.log(`\n🔔 [PUSH TRIGGER] =======================================`);
    console.log(`   🆔 ID: ${activationId}`);
    console.log(`   📬 Источник: ${message.source || 'client/unknown'}`);
    
    let bodyText = '';
    
     if (message.code) {
       bodyText = `Код: ${message.code}`; 
       console.log(`   🔑 КОД: ${message.code}`);
    } else {
       const raw = message.text || '';
       bodyText = raw;
       console.log(`   📄 ТЕКСТ: ${raw.substring(0, 50)}...`);
    }

    console.log(`   🚀 Отправка Push-уведомления...`);

    const payload = JSON.stringify({
      title: titleText,
      body: bodyText,
      icon: 'https://cdn-icons-png.flaticon.com/512/561/561127.png'
    });

    webpush.sendNotification(subscription, payload)
      .then(() => {
        console.log(`   ✅ [PUSH SENT] 200 OK.`);
        
        // Помечаем в базе, что пуш ушел
        db.ref(`activations/${activationId}/messages/${msgKey}`).update({
          pushSent: true
        });
      })
      .catch(err => {
        console.error(`   ❌ [PUSH FAILED] ${err.statusCode}`);
        // Авто-очистка
        if (err.statusCode === 410 || err.statusCode === 404) {
           console.log(`   💀 [CLEANUP] Токен устарел. Удаляем.`);
           db.ref(`activations/${activationId}/pushSubscription`).remove();
        }
      });
      
    console.log(`==========================================================\n`);
  });
});

app.get('/', (req, res) => res.send('Backend Watchtower v2.0 Active 🛡️'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🌍 Server port: ${PORT}`));
