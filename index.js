const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==========================================
// 1. НАСТРОЙКА FIREBASE (ЧИТАЕМ ИЗ RENDER)
// ==========================================

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ [SYSTEM] Ключи Firebase загружены из ENV.");
  } catch (e) {
    console.error('❌ [SYSTEM] ОШИБКА JSON в ENV переменной!');
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log("⚠️ [SYSTEM] Ключи загружены из локального файла.");
  } catch (e) {
    console.error('❌ [SYSTEM] Ключи не найдены нигде!');
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
// 3. ЛОГИКА СЛУШАТЕЛЯ (МАКСИМАЛЬНЫЕ ЛОГИ)
// ==========================================

const ref = db.ref('activations');

console.log('👀 [WATCHTOWER] Сервер запущен. Начинаю мониторинг базы...');

// ЛОГЕР 1: ПОКАЗЫВАЕТ, КТО КУПИЛ НОМЕР И ЖДЕТ
ref.on('child_added', (snapshot) => {
  const id = snapshot.key;
  const data = snapshot.val();
  const hasToken = !!data.pushSubscription;
  const phone = data.phoneNumber || 'Номер не определен';
  const service = data.serviceName || 'Сервис';

  // Логируем только активные, где еще нет кучи сообщений
  // (чтобы не засорять лог при рестарте старыми заказами)
  console.log(`🛒 [NEW ORDER] ID: ${id} | Tel: ${phone} (${service}) | Device Connected: ${hasToken ? '✅ YES' : '❌ NO'}`);
});

// ЛОГЕР 2: ОСНОВНАЯ РАБОТА (ПРИХОД СМС)
ref.on('child_changed', (snapshot) => {
  const activationId = snapshot.key;
  const data = snapshot.val();
  
  // 1. Проверяем подписку
  if (!data.pushSubscription) {
    console.log(`⚠️ [SKIP] Пришло обновление для ${activationId}, но у клиента нет подписки на уведомления.`);
    return;
  }

  // 2. Проверяем сообщения
  if (!data.messages) return;

  const messages = data.messages;
  const subscription = data.pushSubscription;

  // 3. Формируем красивый заголовок (Номер телефона или Сервис)
  const titleText = data.phoneNumber 
    ? `${data.phoneNumber}` 
    : (data.serviceName ? `${data.serviceName} Code` : 'Новое СМС');

  // 4. Перебираем сообщения
  Object.keys(messages).forEach(msgKey => {
    const message = messages[msgKey];
    
    // Если уже отправили - пропускаем
    if (message.pushSent) return;

    // Чистим текст: если есть код - берем код, иначе текст (обрезанный)
    let bodyText = '';
    let logText = '';

    if (message.code) {
       bodyText = `Код: ${message.code}`;
       logText = `CODE: ${message.code}`;
    } else {
       const raw = message.text || '';
       bodyText = raw.length > 30 ? raw.substring(0, 30) + '...' : raw;
       logText = `TEXT: ${raw.substring(0, 20)}...`;
    }

    console.log(`🔔 [SMS DETECTED] ID: ${activationId} | From: ${titleText} | Content: ${logText}`);
    console.log(`   👉 Отправка Push-уведомления...`);

    const payload = JSON.stringify({
      title: titleText,
      body: bodyText,
      icon: 'https://cdn-icons-png.flaticon.com/512/561/561127.png'
    });

    webpush.sendNotification(subscription, payload)
      .then(() => {
        console.log(`   ✅ [SUCCESS] Пуш успешно доставлен пользователю!`);
        
        // Помечаем в базе как отправленное
        db.ref(`activations/${activationId}/messages/${msgKey}`).update({
          pushSent: true
        });
      })
      .catch(err => {
        console.error(`   ❌ [FAILED] Ошибка отправки: ${err.statusCode}`);
        
        // Если клиент отписался или токен протух
        if (err.statusCode === 410 || err.statusCode === 404) {
           console.log(`   💀 [CLEANUP] Подписка мертва. Удаляю токен из базы для ${activationId}`);
           db.ref(`activations/${activationId}/pushSubscription`).remove();
        }
      });
  });
});

app.get('/', (req, res) => res.send('Backend Watchtower Active 🛡️'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🌍 Server port: ${PORT}`));
