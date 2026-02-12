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

// Проверяем, есть ли переменная на Render
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    // Если есть, превращаем строку обратно в объект
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Ключи Firebase успешно загружены из настроек Render.");
  } catch (e) {
    console.error('❌ ОШИБКА: Переменная FIREBASE_SERVICE_ACCOUNT содержит кривой JSON!');
    process.exit(1);
  }
} else {
  // Если переменной нет (например, ты запускаешь локально и файл лежит рядом)
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log("⚠️ Загрузка ключей из локального файла serviceAccountKey.json");
  } catch (e) {
    console.error('❌ ОШИБКА: Не найдена переменная окружения FIREBASE_SERVICE_ACCOUNT и файл serviceAccountKey.json тоже отсутствует.');
    console.error('👉 На Render: добавь переменную FIREBASE_SERVICE_ACCOUNT в настройках.');
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
// 3. ЛОГИКА СЛУШАТЕЛЯ
// ==========================================

const ref = db.ref('activations');

ref.on('child_changed', (snapshot) => {
  const activationId = snapshot.key;
  const data = snapshot.val();
  
  if (!data.messages || !data.pushSubscription) return;

  const messages = data.messages;
  const subscription = data.pushSubscription;

  Object.keys(messages).forEach(msgKey => {
    const message = messages[msgKey];
    if (message.pushSent) return;

    const text = message.text || message.code || 'Код пришел!';
    console.log(`📩 [${activationId}] Отправляем пуш: ${text}`);

    const payload = JSON.stringify({
      title: `Новое СМС!`,
      body: text,
      icon: 'https://cdn-icons-png.flaticon.com/512/561/561127.png'
    });

    webpush.sendNotification(subscription, payload)
      .then(() => {
        db.ref(`activations/${activationId}/messages/${msgKey}`).update({
          pushSent: true
        });
      })
      .catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
           db.ref(`activations/${activationId}/pushSubscription`).remove();
        }
      });
  });
});

app.get('/', (req, res) => res.send('Backend Working 🚀'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
