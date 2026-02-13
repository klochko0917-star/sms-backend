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
// 0. КЭШ ДЛЯ ЗАЩИТЫ ОТ ДУБЛЕЙ (🔥 FIX DUPLICATES)
// ==========================================
// Храним ключи вида: "activationId_code"
// Если код уже отправляли в последние 60 сек, второй раз не шлем.
const sentMessagesCache = new Set();

function isMessageProcessed(id, code) {
  // Если кода нет (например просто текст), не кэшируем жестко, или используем текст как ключ
  const safeCode = code || 'text_msg'; 
  const key = `${id}_${safeCode}`;
  
  if (sentMessagesCache.has(key)) return true;
  
  // Добавляем в кэш
  sentMessagesCache.add(key);
  
  // Удаляем через 60 секунд (чистим память)
  setTimeout(() => {
    sentMessagesCache.delete(key);
  }, 60000);
  
  return false;
}

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
// 4. СИСТЕМА ACTIVE POLLING (СЕРВЕРНАЯ ПРОВЕРКА)
// ==========================================

const activePollers = new Map();

function startPolling(activationId, data) {
  if (activePollers.has(activationId)) return;

  const startTime = data.createdAt || Date.now();
  const LIFE_TIME_MS = 20 * 60 * 1000; // 20 минут
  const formattedPhone = formatPhoneNumber(data.phoneNumber);

  console.log(`🔍 [POLLING START] Начинаю следить за ID: ${activationId} (${formattedPhone})`);

  const intervalId = setInterval(async () => {
    // 1. Проверка времени
    const elapsed = Date.now() - startTime;
    if (elapsed > LIFE_TIME_MS) {
      console.log(`⏰ [POLLING TIMEOUT] ID: ${activationId} — время истекло. Остановка.`);
      stopPolling(activationId);
      return;
    }

    try {
      // 2. Запрос к API
      const res = await heroApiServer.getStatus(activationId);

      // 3. Отмена
      if (res.status === 'CANCELLED' || res.status === '8') {
        console.log(`❌ [POLLING STOP] ID: ${activationId} — отменен на сервисе.`);
        stopPolling(activationId);
        return;
      }

      // 4. Найден КОД
      if (res.code) {
        const incomingCode = String(res.code);
        
        // 4.1 Проверяем существование в БД
        const msgRef = db.ref(`activations/${activationId}/messages/${incomingCode}`);
        const snapshot = await msgRef.once('value');

        if (snapshot.exists()) {
          // Уже есть в базе - пропускаем
          return;
        }

        console.log(`⚡ [POLLING HIT] ID: ${activationId} — НАЙДЕН НОВЫЙ КОД: ${incomingCode}`);

        // 4.2 Получаем текст
        let textToSave = res.text;
        if (!textToSave) {
          try {
             const list = await heroApiServer.getCurrentActivations();
             const item = list.find(i => String(i.id) === String(activationId));
             if (item && item.smsText) textToSave = item.smsText;
          } catch(err) {
             console.error(`⚠️ [POLLING TEXT ERROR] ${err.message}`);
          }
        }
        
        const finalText = textToSave || 'No text';

        // 4.3 Пишем в базу (PushSent = false, чтобы триггернуть Listener)
        await msgRef.set({
          code: incomingCode,
          text: finalText,
          serviceCode: data.serviceName || 'unknown',
          timestamp: Date.now(),
          pushSent: false,  
          source: 'server_polling'
        });

        console.log(`💾 [POLLING SAVED] Код сохранен в базу. Ожидаем отправку пуша...`);

        // 4.4 Подтверждаем получение
        await heroApiServer.setStatus(activationId, 3);
      }

    } catch (err) {
      console.error(`⚠️ [POLLING ERROR] ID: ${activationId}: ${err.message}`);
    }

  }, 3000); // Каждые 3 секунды

  activePollers.set(activationId, intervalId);
}

function stopPolling(activationId) {
  const intervalId = activePollers.get(activationId);
  if (intervalId) {
    clearInterval(intervalId);
    activePollers.delete(activationId);
    console.log(`🛑 [POLLING STOPPED] ID: ${activationId} удален из мониторинга.`);
  }
}

// ==========================================
// 5. ЛОГИКА СЛУШАТЕЛЯ (MEGA LOGS + FIX DUPLICATES)
// ==========================================

const ref = db.ref('activations');

console.log('👀 [WATCHTOWER] Сервер запущен. Мониторинг базы в реальном времени...');
console.log('🛡️ [SYSTEM] Защита от дублей уведомлений (Cache) активирована.');

// --- INIT ---
ref.once('value', (snapshot) => {
  const allData = snapshot.val();
  if (!allData) {
    console.log('📭 [STARTUP] База пуста, ожидаю заказы.');
    return;
  }
  
  let count = 0;
  Object.keys(allData).forEach(key => {
    const data = allData[key];
    const created = data.createdAt || Date.now();
    if (Date.now() - created < 20 * 60 * 1000) {
      startPolling(key, data);
      count++;
    }
  });
  console.log(`📊 [STARTUP] Восстановлено наблюдение за ${count} активными номерами.`);
});


// --- ADDED ---
ref.on('child_added', (snapshot) => {
  const id = snapshot.key;
  const data = snapshot.val();
  const formattedPhone = formatPhoneNumber(data.phoneNumber || '???');
  const service = data.serviceName || 'Unknown Service';

  console.log(`\n🟢 [NEW ACTIVATION] ID: ${id} | ${formattedPhone} (${service})`);
  startPolling(id, data);
});

// --- REMOVED ---
ref.on('child_removed', (snapshot) => {
  const id = snapshot.key;
  stopPolling(id);
});

// --- CHANGED (MAIN LOGIC WITH FIX) ---
ref.on('child_changed', (snapshot) => {
  const activationId = snapshot.key;
  const data = snapshot.val();
  
  if (!data.pushSubscription || !data.messages) return;

  const messages = data.messages;
  const subscription = data.pushSubscription;
  const rawPhone = data.phoneNumber;
  const titleText = rawPhone ? formatPhoneNumber(rawPhone) : (data.serviceName || 'Новое СМС');

  Object.keys(messages).forEach(msgKey => {
    const message = messages[msgKey];
    
    // 1. Если флаг уже стоит в базе — выходим
    if (message.pushSent) return;

    // 2. 🔥 ВНЕДРЕННЫЙ ФИКС: Проверка кэша
    // Если этот код для этого ID мы уже отправляли (даже если флаг в базе еще false)
    if (isMessageProcessed(activationId, message.code)) {
      console.log(`🚫 [DUPLICATE BLOCKED] ID: ${activationId} Код: ${message.code} — пуш уже отправлен.`);
      
      // На всякий случай обновляем флаг в БД, чтобы он там точно стал true
      db.ref(`activations/${activationId}/messages/${msgKey}`).update({ pushSent: true }).catch(()=>{});
      return;
    }

    // --- ЛОГИРОВАНИЕ ---
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
        
        // Помечаем в базе
        db.ref(`activations/${activationId}/messages/${msgKey}`).update({
          pushSent: true
        });
      })
      .catch(err => {
        console.error(`   ❌ [PUSH FAILED] ${err.statusCode}`);
        if (err.statusCode === 410 || err.statusCode === 404) {
           console.log(`   💀 [CLEANUP] Токен устарел. Удаляем.`);
           db.ref(`activations/${activationId}/pushSubscription`).remove();
        }
      });
      
    console.log(`==========================================================\n`);
  });
});

app.get('/', (req, res) => res.send('Backend Watchtower v2.1 Active + AntiDup 🛡️'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🌍 Server port: ${PORT}`));
