// ============================================================================
//  ПРОСТОЙ МЕССЕНДЖЕР — часть в браузере («поведение»)
// ----------------------------------------------------------------------------
//  Этот файл делает так, что кнопки работают, сообщения летают на сервер
//  и обратно, а новые сообщения появляются сами.
// ============================================================================

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  users: [],
  conversations: [],
  activeConvId: null,
  activeOtherName: null,
  lastMessageId: 0,
  pollTimer: null,
  authMode: 'register', // 'register' или 'login'
};

// --- Маленький помощник для общения с сервером -------------------------------
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* пустой ответ — это ок */ }
  if (!res.ok) {
    const message = (data && data.error) || 'Что-то пошло не так.';
    throw new Error(message);
  }
  return data;
}

// ============================================================================
//  ЭКРАН ВХОДА
// ============================================================================

$('tab-register').addEventListener('click', () => setAuthMode('register'));
$('tab-login').addEventListener('click', () => setAuthMode('login'));

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  $('tab-register').classList.toggle('active', isRegister);
  $('tab-login').classList.toggle('active', !isRegister);
  $('auth-submit').textContent = isRegister ? 'Создать меня' : 'Войти';
  $('auth-error').hidden = true;
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('auth-error');
  errorEl.hidden = true;
  $('auth-submit').disabled = true;

  const username = $('username').value.trim();
  const password = $('password').value;

  try {
    const path = state.authMode === 'register' ? '/api/register' : '/api/login';
    const data = await api(path, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.me = data.user;
    await enterChat();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  stopPolling();
  state.me = null;
  state.activeConvId = null;
  $('chat-screen').hidden = true;
  $('auth-screen').hidden = false;
  $('password').value = '';
});

// ============================================================================
//  ЭКРАН ЧАТА
// ============================================================================

async function enterChat() {
  $('auth-screen').hidden = true;
  $('chat-screen').hidden = false;
  $('me-name').textContent = state.me.username;
  await refreshSidebar();
}

async function refreshSidebar() {
  const [usersData, convData] = await Promise.all([
    api('/api/users'),
    api('/api/conversations'),
  ]);
  state.users = usersData.users;
  state.conversations = convData.conversations;
  renderPeople();
  renderChats();
}

function renderPeople() {
  const list = $('people-list');
  list.innerHTML = '';
  $('people-empty').hidden = state.users.length > 0;

  state.users.forEach((user) => {
    const li = document.createElement('li');
    li.textContent = user.username;
    li.addEventListener('click', () => startConversation(user));
    list.appendChild(li);
  });
}

function renderChats() {
  const list = $('chat-list');
  list.innerHTML = '';
  $('chats-empty').hidden = state.conversations.length > 0;

  state.conversations.forEach((conv) => {
    const li = document.createElement('li');
    li.textContent = conv.other_name;
    if (conv.last_body) {
      li.title = conv.last_body;
    }
    if (conv.id === state.activeConvId) li.classList.add('active');
    li.addEventListener('click', () => openConversation(conv.id, conv.other_name));
    list.appendChild(li);
  });
}

async function startConversation(user) {
  try {
    const data = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: user.id }),
    });
    await refreshSidebar();
    openConversation(data.conversationId, user.username);
  } catch (err) {
    alert(err.message);
  }
}

// --- Область переписки -------------------------------------------------------
let convReady = false;

// Один раз строим окно переписки из шаблона и заменяем им заглушку.
function ensureConversationUI() {
  if (convReady) return;
  const tpl = $('conversation-template');
  $('no-chat').replaceWith(tpl.content.cloneNode(true));
  document.getElementById('send-form').addEventListener('submit', sendMessage);
  convReady = true;
}

async function openConversation(convId, otherName) {
  ensureConversationUI();
  state.activeConvId = convId;
  state.activeOtherName = otherName;
  state.lastMessageId = 0;

  document.getElementById('conv-title').textContent = otherName;
  document.getElementById('messages').innerHTML = '';
  renderChats();

  const data = await api(`/api/conversations/${convId}/messages?after=0`);
  appendMessages(data.messages);
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollNewMessages, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollNewMessages() {
  if (!state.activeConvId) return;
  try {
    const data = await api(
      `/api/conversations/${state.activeConvId}/messages?after=${state.lastMessageId}`
    );
    if (data.messages.length) {
      appendMessages(data.messages);
      refreshSidebar();
    }
  } catch (_) {
    // Если что-то разладилось, просто попробуем в следующий раз.
  }
}

function formatTime(sqlTime) {
  // В базе время в формате UTC — добавляем «Z» и показываем местное время.
  const date = new Date(sqlTime.replace(' ', 'T') + 'Z');
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function appendMessages(messages) {
  const box = document.getElementById('messages');
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  messages.forEach((msg) => {
    if (msg.id > state.lastMessageId) state.lastMessageId = msg.id;

    const div = document.createElement('div');
    div.className = 'bubble ' + (msg.sender_id === state.me.id ? 'me' : 'other');

    const text = document.createElement('span');
    text.textContent = msg.body; // textContent защищает от «вредных» символов

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(msg.created_at);

    div.appendChild(text);
    div.appendChild(time);
    box.appendChild(div);
  });

  if (wasNearBottom) box.scrollTop = box.scrollHeight;
}

async function sendMessage(e) {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const body = input.value.trim();
  if (!body || !state.activeConvId) return;

  input.value = '';
  try {
    const data = await api(`/api/conversations/${state.activeConvId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    appendMessages([data.message]);
    refreshSidebar();
  } catch (err) {
    input.value = body;
    alert(err.message);
  }
}

// ============================================================================
//  СТАРТ
// ============================================================================

(async function boot() {
  try {
    const data = await api('/api/me');
    state.me = data.user;
    await enterChat();
  } catch (_) {
    // Не вошёл — показываем экран входа.
    $('auth-screen').hidden = false;
    $('chat-screen').hidden = true;
  }
})();
