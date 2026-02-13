const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const PNF = require('google-libphonenumber').PhoneNumberFormat;
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const axios = require('axios'); // ✅ ДОБАВИЛ AXIOS ДЛЯ ЗАПРОСОВ К SMS

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
  
  // Если уже есть плюс, но нет пробелов - пробуем форматировать
  // Если плюса нет - добавляем
  let numberToParse = String(rawNumber);
  if (!numberToParse.startsWith('+')) {
      numberToParse = '+' + numberToParse;
  }

  try {
    const number = phoneUtil.parseAndKeepRawInput(numberToParse);
    // INTERNATIONAL формат дает: +380 67 577 09 11
    return phoneUtil.format(number, PNF.INTERNATIONAL); 
  } catch (e) {
    // Если ошибка парсинга (странный номер), возвращаем как есть, но с плюсом
    return numberToParse;
  }
}

// ==========================================
// 4.5. ФОНОВЫЙ ОПРОС (ЭТО Я ДОБАВИЛ)
// ==========================================

// Твои настройки API (взяты из твоего apiService.js)
const SMS_API_KEY = '0eA49025bAc743e0d3df93f215fc70b7'; 
// !!! ВНИМАНИЕ: Здесь должен быть реальный URL провайдера. 
// Я оставил дефолтный SMS-Activate. Если у тебя другой (5sim и тд) - замени URL ниже.
const SMS_PROVIDER_URL = 'https://api.sms-activate.org/stubs/handler_api.php'; 

async function checkSmsProvider() {
  try {
    // 1. Запрос к API
    const response = await axios.get(SMS_PROVIDER_URL, {
      params: { api_key: SMS_API_KEY, action: 'getActiveActivations' }
    });
    
    const data = response.data;
    if (!data || data === 'NO_ACTIVATIONS') return;

    // 2. Парсинг
    let list = [];
    if (data.activeActivations) {
        if (Array.isArray(data.activeActivations)) list = data.activeActivations;
        else if (data.activeActivations.rows) list = data.activeActivations.rows;
        else if (data.activeActivations.row) list = [data.activeActivations.row];
    }

    // 3. Обработка
    for (const item of list) {
      const smsCode = (Array.isArray(item.smsCode) ? item.smsCode[0] : item.smsCode);
      if (!smsCode) continue;

      const id = item.activationId;
      const safeKey = String(smsCode).replace(/[.#$\/\[\]]/g, "");

      // 4. Проверяем базу Firebase (есть ли такая активация у нас)
      const actRef = db.ref(`activations/${id}`);
      const actSnap = await actRef.once('value');
      
      if (!actSnap.exists()) continue; // Чужой номер

      // 5. Проверяем сообщение
      const msgRef = db.ref(`activations/${id}/messages/${safeKey}`);
      const msgSnap = await msgRef.once('value');

      // Если новое -> пишем в базу
      if (!msgSnap.exists()) {
        console.log(`✨ [POLLING] Нашел новый код для ID ${id}: ${smsCode}`);
        
        await msgRef.set({
          code: String(smsCode),
          text: item.text || item.smsText || 'Текст не получен',
          timestamp: Date.now(),
          pushSent: false // !!! Важно: false, чтобы сработал твой слушатель ниже
        });

        // Обновляем статус самой активации
        await actRef.update({ 
           smsCode: String(smsCode),
           status: 'Active'
        });
      }
    }
  } catch (e) {
    // Тихо игнорируем ошибки сети, чтобы не спамить в лог
  }
}

// Запускаем опрос каждые 3 секунды
setInterval(checkSmsProvider, 3000);
console.log('🤖 [POLLING] Фоновая проверка API запущена (3 сек).');


// ==========================================
// 4. ЛОГИКА СЛУШАТЕЛЯ (MEGA LOGS) - ТВОЙ КОД
// ==========================================

const ref = db.ref('activations');

console.log('👀 [WATCHTOWER] Сервер запущен. Мониторинг базы в реальном времени...');
console.log('📊 [STATS] Ожидание новых заказов и СМС...');

// --- ЛОГЕР 1: НОВЫЙ ЗАКАЗ ---
ref.on('child_added', (snapshot) => {
  const id = snapshot.key;
  const data = snapshot.val();
  
  // Пропускаем старые записи при старте (если они старше 1 часа, например), 
  // но для наглядности пока выводим всё
  const hasToken = !!data.pushSubscription;
  const rawPhone = data.phoneNumber || '???';
  const formattedPhone = formatPhoneNumber(rawPhone);
  const service = data.serviceName || 'Unknown Service';

  console.log(`\n🟢 [NEW ACTIVATION] ---------------------------------------`);
  console.log(`   🆔 ID: ${id}`);
  console.log(`   📱 Tel: ${formattedPhone} (${service})`);
  console.log(`   🔔 Push Token: ${hasToken ? '✅ CONNECTED' : '❌ MISSING'}`);
  console.log(`-----------------------------------------------------------\n`);
});

// --- ЛОГЕР 2: УДАЛЕНИЕ ЗАКАЗА (ОТМЕНА/ЗАВЕРШЕНИЕ) ---
ref.on('child_removed', (snapshot) => {
  const id = snapshot.key;
  const data = snapshot.val();
  const rawPhone = data.phoneNumber || '???';
  
  console.log(`🔴 [REMOVED] Заказ ${id} (${formatPhoneNumber(rawPhone)}) удален из базы.\n`);
});

// --- ЛОГЕР 3: ИЗМЕНЕНИЯ (ГЛАВНОЕ - СМС) ---
ref.on('child_changed', (snapshot) => {
  const activationId = snapshot.key;
  const data = snapshot.val();
  
  // 1. Проверка подписки
  if (!data.pushSubscription) {
    // Чтобы не спамить логами, пишем только если пришли сообщения, а токена нет
    if (data.messages) {
       console.log(`⚠️ [SKIP] ID: ${activationId} получил СМС, но у клиента НЕТ подписки.`);
    }
    return;
  }

  if (!data.messages) return;

  const messages = data.messages;
  const subscription = data.pushSubscription;
  
  // Форматируем номер для заголовка
  const rawPhone = data.phoneNumber;
  const titleText = rawPhone ? formatPhoneNumber(rawPhone) : (data.serviceName || 'Новое СМС');

  Object.keys(messages).forEach(msgKey => {
    const message = messages[msgKey];
    
    // Если уже отправлено - молчим
    if (message.pushSent) return;

    // --- ЛОГИРОВАНИЕ СМС ---
    console.log(`\n🔔 [SMS DETECTED] =======================================`);
    console.log(`   🆔 ID: ${activationId}`);
    console.log(`   📬 От кого: ${titleText}`);
    
    let bodyText = '';
    
     if (message.code) {
       // ✅ ИСПРАВЛЕНО: Добавлено слово "Код: "
       bodyText = `Код: ${message.code}`; 
       console.log(`   🔑 КОД: ${message.code}`);
    } else {
       const raw = message.text || '';
       bodyText = raw;
       console.log(`   📄 ТЕКСТ: ${raw.substring(0, 50)}...`);
    }

    // Отправка
    console.log(`   🚀 Отправка Push-уведомления на устройство...`);

    const payload = JSON.stringify({
      title: titleText, // Теперь тут красивый номер: +380 67...
      body: bodyText,   // Просто код
      icon: 'https://cdn-icons-png.flaticon.com/512/561/561127.png'
    });

    webpush.sendNotification(subscription, payload)
      .then(() => {
        console.log(`   ✅ [SUCCESS] 200 OK. Доставлено пользователю.`);
        
        // Помечаем в базе
        db.ref(`activations/${activationId}/messages/${msgKey}`).update({
          pushSent: true
        });
      })
      .catch(err => {
        console.error(`   ❌ [FAILED] Ошибка отправки: ${err.statusCode}`);
        console.error(`   👉 Details:`, err.body || err);

        // Авто-очистка мертвых токенов
        if (err.statusCode === 410 || err.statusCode === 404) {
           console.log(`   💀 [CLEANUP] Устройство отписалось. Удаляем токен из базы.`);
           db.ref(`activations/${activationId}/pushSubscription`).remove();
        }
      });
      
    console.log(`==========================================================\n`);
  });
});

app.get('/', (req, res) => res.send('Backend Watchtower v2.0 Active 🛡️'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🌍 Server port: ${PORT}`));
