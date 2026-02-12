const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');

// === 1. НАСТРОЙКА FIREBASE ADMIN ===
// ВАЖНО: Тебе нужно создать файл 'serviceAccountKey.json' рядом с server.js
// Скачай его в консоли Firebase: Project Settings -> Service Accounts
// Если не хочешь файл, можно передать объект JSON прямо в код (но это менее безопасно)
let serviceAccount;
try {
  serviceAccount = require('./serviceAccountKey.json');
} catch (e) {
  console.error("❌ ОШИБКА: Не найден файл serviceAccountKey.json!");
  console.error("Скачайте его из Firebase Console и положите в корень папки backend");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sms-history-3c45e-default-rtdb.europe-west1.firebasedatabase.app/"
});

const db = admin.database();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// === 2. НАСТРОЙКА WEB PUSH ===
const PUBLIC_VAPID_KEY = 'BOY5OXY2TLy2mrgrJKtpJx53RLAamrpHJ7GpuvHsaN2WKFcz8WHbwAeNEBgULGwkhTe6o0UR-FHqOjR2VbrpaaQ';
const PRIVATE_VAPID_KEY = 'RJkp_M-bEsQdFhNcQ49jsQhnwHg-_2nrC-RBuNJUIDs';

webpush.setVapidDetails(
  'mailto:admin@neohub.com',
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

// === 3. ОСНОВНАЯ ЛОГИКА: СЛУШАЕМ FIREBASE ===
console.log('🚀 Бэкенд запущен и слушает базу данных Firebase...');

const ref = db.ref('activations');

// Слушаем ИЗМЕНЕНИЯ в существующих активациях (например, пришла новая смс)
ref.on('child_changed', (snapshot) => {
  const activationId = snapshot.key;
  const data = snapshot.val();
  
  // 1. Проверяем, есть ли сообщения и есть ли подписка
  if (!data.messages || !data.pushSubscription) return;

  const messages = data.messages;
  const subscription = data.pushSubscription;

  // 2. Перебираем сообщения, ищем новые
  Object.keys(messages).forEach(msgKey => {
    const message = messages[msgKey];
    
    // Если пуш уже отправлен (флаг pushSent == true), пропускаем
    if (message.pushSent) return;

    const sender = message.sender || 'Service';
    const text = message.text || message.code || 'Новое сообщение';
    const cleanText = text.length > 50 ? text.substring(0, 50) + '...' : text;

    console.log(`📩 [${activationId}] Новое СМС: ${cleanText}`);

    // 3. Формируем Payload
    const payload = JSON.stringify({
      title: `СМС от ${sender}`,
      body: text,
      icon: 'https://cdn-icons-png.flaticon.com/512/561/561127.png' // Можно заменить на свою иконку
    });

    // 4. Отправляем пуш
    webpush.sendNotification(subscription, payload)
      .then(() => {
        console.log(`✅ Пуш отправлен для ${activationId}`);
        // 5. ВАЖНО: Ставим флаг, что отправили
        db.ref(`activations/${activationId}/messages/${msgKey}`).update({
          pushSent: true
        });
      })
      .catch(err => {
        console.error(`❌ Ошибка отправки пуша [${err.statusCode}]:`, err.message);
        
        // Если клиент отписался или токен умер -> удаляем подписку из базы, чтобы не пытаться снова
        if (err.statusCode === 410 || err.statusCode === 404) {
           console.log('💀 Подписка мертва, удаляем из базы...');
           db.ref(`activations/${activationId}/pushSubscription`).remove();
        }
      });
  });
});

// === 4. ОБЫЧНЫЕ РОУТЫ (Для совместимости, если нужно) ===

// Роут подписки теперь опционален, так как фронт сам получает токен.
// Но оставим для отладки.
app.post('/subscribe', (req, res) => {
  res.status(200).json({ message: 'Теперь подписка обрабатывается через Firebase' });
});

app.get('/', (req, res) => {
  res.send('NeoHub Firebase Listener Active 🚀');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🌍 Server listening on port ${PORT}`));
