// ============================================================================
//  ПРОСТОЙ МЕССЕНДЖЕР — серверная часть («мозг»)
// ----------------------------------------------------------------------------
//  Что здесь происходит, простыми словами:
//   1. Храним людей, чаты и сообщения в базе данных SQLite (это один файл).
//   2. Даём браузеру «ручки» (адреса), через которые он может:
//        - представиться (регистрация) и войти,
//        - увидеть список людей,
//        - выбрать, с кем общаться,
//        - отправить сообщение и получить историю.
//   3. Пароли храним в зашифрованном виде, чтобы их нельзя было выкрасть.
//
//  Ничего дополнительно запускать не нужно: сервер всё делает сам.
// ============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// --- Настройки ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// Папка, где лежит файл базы. На сервере Dokploy сюда подключим постоянное хранилище.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_MESSAGE_LENGTH = 2000;

// --- База данных -------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'messenger.db'));
db.pragma('journal_mode = WAL'); // надёжный режим записи

// Создаём таблицы, если их ещё нет.
// Таблица — это как лист в Excel: свои столбцы и строки.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a     INTEGER NOT NULL,
    user_b     INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_a, user_b)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id       INTEGER NOT NULL,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
`);

// --- Заготовленные запросы к базе -------------------------------------------
const q = {
  insertUser: db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE'),

  insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
  findSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),

  findConversation: db.prepare(
    'SELECT * FROM conversations WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)'
  ),
  insertConversation: db.prepare('INSERT INTO conversations (user_a, user_b) VALUES (?, ?)'),
  listConversations: db.prepare(`
    SELECT
      c.id,
      CASE WHEN c.user_a = @me THEN c.user_b ELSE c.user_a END AS other_id,
      u.username AS other_name,
      (SELECT body       FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM conversations c
    JOIN users u ON u.id = CASE WHEN c.user_a = @me THEN c.user_b ELSE c.user_a END
    WHERE c.user_a = @me OR c.user_b = @me
    ORDER BY c.id DESC
  `),

  getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)'
  ),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  listMessages: db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 500'
  ),
};

// --- Сервер ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Простой «разбор печенек» (cookie) — маленьких записок от браузера,
// чтобы сервер помнил, что человек уже вошёл.
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Проверка: кто именно сейчас обращается к серверу.
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const session = q.findSession.get(token);
  if (!session) return null;
  return q.findById.get(session.user_id) || null;
}

// Вход разрешён только тем, кто уже вошёл.
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Нужно сначала войти.' });
  req.user = user;
  next();
}

// --- Регистрация и вход ------------------------------------------------------
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: 'Имя должно быть от 2 до 20 символов.' });
  }
  if (!/^[\p{L}\p{N} _.-]+$/u.test(username)) {
    return res.status(400).json({ error: 'В имени можно использовать буквы, цифры, пробел, точку, дефис и _.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль должен быть хотя бы 4 символа.' });
  }
  if (q.findByUsername.get(username)) {
    return res.status(409).json({ error: 'Такое имя уже занято. Выбери другое.' });
  }

  const hash = bcrypt.hashSync(password, 10); // шифруем пароль
  const info = q.insertUser.run(username, hash);
  const userId = Number(info.lastInsertRowid);

  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, userId);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.json({ user: { id: userId, username } });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const user = q.findByUsername.get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверное имя или пароль.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, user.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.json({ user: { id: user.id, username: user.username } });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).sid;
  if (token) q.deleteSession.run(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Не вошёл.' });
  res.json({ user });
});

// --- Люди и чаты -------------------------------------------------------------
app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: q.listUsers.all(req.user.id) });
});

app.get('/api/conversations', requireAuth, (req, res) => {
  res.json({ conversations: q.listConversations.all({ me: req.user.id }) });
});

// Открыть (или создать) чат с выбранным человеком.
app.post('/api/conversations', requireAuth, (req, res) => {
  const otherId = Number(req.body.userId);
  if (!Number.isInteger(otherId) || otherId === req.user.id) {
    return res.status(400).json({ error: 'Некорректный собеседник.' });
  }
  if (!q.findById.get(otherId)) {
    return res.status(404).json({ error: 'Такого человека нет.' });
  }

  // Всегда кладём меньший id первым — так у пары будет ровно один чат.
  const a = Math.min(req.user.id, otherId);
  const b = Math.max(req.user.id, otherId);

  let conv = q.findConversation.get(a, b, a, b);
  if (!conv) {
    const info = q.insertConversation.run(a, b);
    conv = q.getConversation.get(Number(info.lastInsertRowid));
  }
  res.json({ conversationId: conv.id });
});

// --- Сообщения ---------------------------------------------------------------
function loadConversationForUser(convId, userId) {
  const conv = q.getConversation.get(convId);
  if (!conv) return null;
  if (conv.user_a !== userId && conv.user_b !== userId) return null; // чужой чат — нельзя
  return conv;
}

// after=0 вернёт всю историю, after=<id> — только новые.
app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const convId = Number(req.params.id);
  const after = Number(req.query.after) || 0;
  const conv = loadConversationForUser(convId, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Чат не найден.' });

  res.json({ messages: q.listMessages.all(convId, after) });
});

app.post('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const convId = Number(req.params.id);
  const body = String(req.body.body || '').trim();
  const conv = loadConversationForUser(convId, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Чат не найден.' });
  if (!body) return res.status(400).json({ error: 'Сообщение пустое.' });
  if (body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Сообщение слишком длинное.' });
  }

  const info = q.insertMessage.run(convId, req.user.id, body);
  res.json({ message: q.getMessage.get(Number(info.lastInsertRowid)) });
});

// Простая проверка «сервер жив» — её любят системы вроде Dokploy.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Отдаём страницу мессенджера.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Мессенджер запущен на порту ${PORT}. База: ${path.join(DATA_DIR, 'messenger.db')}`);
});
