// Telegram-бот «Государства» — Cloudflare Workers + D1 (без зависимостей)

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const btn = (text, data) => ({ text, callback_data: data });
const BACK = [[btn('⬅️ В меню', 'menu')]];
const CANCEL = [[btn('✖️ Отмена', 'cancel')]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ownerName = (env) => String(env.OWNER_USERNAME || 'hamtik26kk').replace('@', '');

// ---------- Telegram API ----------
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error_code: 0, description: String(e) };
  }
}
const send = (env, chat, text, kb) =>
  tg(env, 'sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: kb ? { inline_keyboard: kb } : undefined,
  });

// Редактирует сообщение с кнопкой, а если нельзя — отправляет новое
async function show(env, c, text, kb) {
  if (c.mid) {
    const r = await tg(env, 'editMessageText', {
      chat_id: c.chat, message_id: c.mid, text, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: { inline_keyboard: kb || [] },
    });
    if (r.ok || /not modified/.test(r.description || '')) return;
  }
  return send(env, c.chat, text, kb);
}

// ---------- База данных ----------
const q = (env, sql, a) => env.DB.prepare(sql).bind(...a);
const one = (env, sql, ...a) => q(env, sql, a).first();
const all = async (env, sql, ...a) => (await q(env, sql, a).all()).results;
const run = (env, sql, ...a) => q(env, sql, a).run();

async function touchUser(env, u) {
  await run(env,
    `INSERT INTO users(id, username, first_name) VALUES(?,?,?)
     ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, blocked=0`,
    u.id, (u.username || '').toLowerCase(), u.first_name || '');
  return one(env, 'SELECT * FROM users WHERE id=?', u.id);
}
const setStep = (env, uid, step, data) =>
  run(env, 'UPDATE users SET step=?, data=? WHERE id=?', step || null, JSON.stringify(data || {}), uid);

async function findUser(env, s) {
  s = s.trim();
  if (/^\d+$/.test(s)) return one(env, 'SELECT * FROM users WHERE id=?', Number(s));
  return one(env, 'SELECT * FROM users WHERE username=?', s.replace(/^@/, '').toLowerCase());
}
const myState = (env, uid) => one(env, 'SELECT * FROM states WHERE leader_id=?', uid);

// ---------- Права ----------
function isOwner(env, u) {
  const oid = String(env.OWNER_ID || '').trim();
  if (oid) return String(u.id) === oid;
  return (u.username || '').toLowerCase() === ownerName(env).toLowerCase();
}
async function isAdmin(env, u) {
  return isOwner(env, u) || !!(await one(env, 'SELECT 1 x FROM admins WHERE user_id=?', u.id));
}
async function adminIds(env) {
  const ids = new Set((await all(env, 'SELECT user_id FROM admins')).map((r) => r.user_id));
  const oid = String(env.OWNER_ID || '').trim();
  if (oid) ids.add(Number(oid));
  else {
    const r = await one(env, 'SELECT id FROM users WHERE username=?', ownerName(env).toLowerCase());
    if (r) ids.add(r.id);
  }
  return [...ids];
}

// ---------- Меню ----------
async function mainMenu(env, c) {
  const kb = [
    [btn('🏛 Создать государство', 'create')],
    [btn('🚪 Вступить в государство', 'join')],
    [btn('💳 Кредиты', 'credits')],
  ];
  if (await myState(env, c.from.id)) kb.splice(2, 0, [btn('🛠 Панель государства', 'panel')]);
  if (await isAdmin(env, c.from)) kb.push([btn('👑 Админ-панель', 'a')]);
  return show(env, c, '👋 Привет! Выбери действие:', kb);
}

async function stateView(env, c, id) {
  const s = await one(env,
    `SELECT s.*, u.first_name ln, u.username lu,
     (SELECT COUNT(*) FROM members WHERE state_id=s.id) n
     FROM states s LEFT JOIN users u ON u.id=s.leader_id WHERE s.id=?`, id);
  if (!s) return show(env, c, 'Государство не найдено.', BACK);
  const mem = await one(env, 'SELECT 1 x FROM members WHERE state_id=? AND user_id=?', id, c.from.id);
  let t = `🏛 <b>${esc(s.name)}</b>\n\n${esc(s.description) || 'Описание не указано.'}\n\n` +
    `👑 Лидер: ${esc(s.ln)}${s.lu ? ' (@' + esc(s.lu) + ')' : ''}\n👥 Граждан: ${s.n}`;
  if (s.weather) t += `\n🌤 Погода: ${esc(s.weather)}`;
  const kb = [[btn('📄 Статьи', `pl:${id}:a`), btn('⚖️ Законы', `pl:${id}:l`)]];
  if (mem) {
    if (s.html_file_id) kb.push([btn('🌐 HTML-страница государства', 'html:' + id)]);
    if (s.leader_id !== c.from.id) kb.push([btn('🚪 Выйти из государства', 'lv:' + id)]);
  } else kb.push([btn('✅ Вступить', 'jr:' + id)]);
  kb.push([btn('⬅️ К списку', 'join')]);
  return show(env, c, t, kb);
}

async function leaderPanel(env, c) {
  const st = await myState(env, c.from.id);
  if (!st) return show(env, c, 'У тебя пока нет государства.', BACK);
  const n = (await one(env, 'SELECT COUNT(*) n FROM members WHERE state_id=?', st.id)).n;
  return show(env, c, `🛠 <b>Панель: ${esc(st.name)}</b>\n👥 Граждан: <b>${n}</b>`, [
    [btn('📰 Новость всем', 'p_news'), btn('🌤 Погода', 'p_wth')],
    [btn('📄 Статья', 'p_art'), btn('⚖️ Закон', 'p_law')],
    [btn('🗑 Статьи/законы', 'pm'), btn('✏️ Описание', 'p_desc')],
    [btn('🌐 HTML-файл', 'p_html'), btn(`👥 Граждане (${n})`, 'p_mem')],
    [btn('👁 Страница государства', 'st:' + st.id)],
    [btn('⬅️ В меню', 'menu')],
  ]);
}

async function postsManage(env, c, st) {
  const rows = await all(env, 'SELECT id, kind, title FROM posts WHERE state_id=? ORDER BY id DESC LIMIT 40', st.id);
  const kb = rows.map((r) => [btn(`🗑 ${r.kind === 'a' ? '📄' : '⚖️'} ${r.title}`.slice(0, 60), 'pd:' + r.id)]);
  kb.push([btn('⬅️ Панель', 'panel')]);
  return show(env, c, rows.length ? 'Нажми на пост, чтобы удалить:' : 'Пока нет статей и законов.', kb);
}

async function adminPanel(env, c) {
  if (!(await isAdmin(env, c.from))) return show(env, c, 'Нет доступа.', BACK);
  const p = await one(env, "SELECT COUNT(*) n FROM requests WHERE status='pending'");
  return show(env, c, '👑 <b>Админ-панель</b>', [
    [btn(`📥 Заявки (${p.n})`, 'a_req')],
    [btn('🏛 Государства / удалить', 'a_states')],
    [btn('➕ Создать государство без заявки', 'a_mk')],
    [btn('👮 Админы', 'a_adm')],
    [btn('📣 Рассылка от админа', 'a_bc')],
    [btn('📊 Статистика', 'a_stats')],
    [btn('⬅️ В меню', 'menu')],
  ]);
}

async function adminsView(env, c, owner) {
  const rows = await all(env,
    'SELECT a.user_id id, u.first_name n, u.username un FROM admins a LEFT JOIN users u ON u.id=a.user_id');
  const kb = owner ? rows.map((r) => [btn(`➖ ${r.n || r.id}${r.un ? ' @' + r.un : ''}`, 'a_rm:' + r.id)]) : [];
  if (owner) kb.push([btn('➕ Добавить админа', 'a_addadm')]);
  kb.push([btn('⬅️ Админ-панель', 'a')]);
  const list = rows.map((r) => `• ${esc(r.n || r.id)}${r.un ? ' @' + esc(r.un) : ''}`).join('\n') || 'пока нет';
  return show(env, c, `👮 <b>Админы</b> (владелец всегда админ)\n${list}${owner ? '\n\nНажми, чтобы убрать:' : ''}`, kb);
}

// ---------- Заявки ----------
async function requestCard(env, r) {
  const u = await one(env, 'SELECT * FROM users WHERE id=?', r.user_id);
  const who = `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'user')}</a>${u.username ? ' (@' + esc(u.username) + ')' : ''}`;
  const t = `📝 <b>Заявка #${r.id}: создать государство</b>\nНазвание: <b>${esc(r.name)}</b>\nОписание: ${esc(r.description) || '—'}\nОт: ${who}`;
  return [t, [[btn('✅ Принять', 'rq_ok:' + r.id), btn('❌ Отклонить', 'rq_no:' + r.id)]]];
}

async function notifyRequest(env, id) {
  const r = await one(env, 'SELECT * FROM requests WHERE id=?', id);
  const [t, kb] = await requestCard(env, r);
  const ids = await adminIds(env);
  for (const to of ids) await send(env, to, t, kb);
}

async function createState(env, leaderId, name, desc) {
  if (await one(env, 'SELECT 1 x FROM states WHERE leader_id=?', leaderId)) return { error: 'у пользователя уже есть государство' };
  if (await one(env, 'SELECT 1 x FROM states WHERE name_key=?', name.toLowerCase())) return { error: 'такое название уже занято' };
  const r = await run(env, 'INSERT INTO states(name, name_key, description, leader_id) VALUES(?,?,?,?)',
    name, name.toLowerCase(), desc || '', leaderId);
  await run(env, 'INSERT OR IGNORE INTO members(state_id, user_id) VALUES(?,?)', r.meta.last_row_id, leaderId);
  return { id: r.meta.last_row_id };
}

// ---------- Новости (рассылка пачками) ----------
async function queueNews(env, m, header, authorId, stateId) {
  const isText = !!m.text;
  const text = (isText ? m.text : m.caption || '').slice(0, isText ? 2500 : 600);
  await run(env,
    'INSERT INTO news(state_id, author_id, header, kind, text, from_chat, message_id) VALUES(?,?,?,?,?,?,?)',
    stateId || null, authorId, header, isText ? 'text' : 'copy', text, m.chat.id, m.message_id);
}

function sendOne(env, n, chat) {
  if (n.kind === 'text') {
    return tg(env, 'sendMessage', {
      chat_id: chat, text: `${n.header}\n\n${esc(n.text)}`, parse_mode: 'HTML', disable_web_page_preview: true,
    });
  }
  return tg(env, 'copyMessage', {
    chat_id: chat, from_chat_id: n.from_chat, message_id: n.message_id,
    caption: `${n.header}${n.text ? '\n\n' + esc(n.text) : ''}`, parse_mode: 'HTML',
  });
}

async function processNews(env) {
  const n = await one(env, 'SELECT * FROM news WHERE done=0 ORDER BY id LIMIT 1');
  if (!n) return;
  const size = Math.min(Number(env.BATCH) || 40, 45);
  const users = await all(env, 'SELECT id FROM users WHERE id>? AND blocked=0 ORDER BY id LIMIT ?', n.last_user, size);
  const last = users.length ? users[users.length - 1].id : n.last_user;
  const finished = users.length < size;
  const claim = await run(env, 'UPDATE news SET last_user=?, done=? WHERE id=? AND last_user=? AND done=0',
    last, finished ? 1 : 0, n.id, n.last_user);
  if (!claim.meta.changes) return; // эту пачку уже обработал другой запуск

  let sent = 0;
  const blocked = [];
  for (const u of users) {
    let r = await sendOne(env, n, u.id);
    if (r.error_code === 429) {
      await sleep(Math.min(r.parameters?.retry_after || 1, 5) * 1000);
      r = await sendOne(env, n, u.id);
    }
    if (r.ok) sent++;
    else if (r.error_code === 403) blocked.push(u.id); // пользователь заблокировал бота
  }
  if (sent) await run(env, 'UPDATE news SET sent=sent+? WHERE id=?', sent, n.id);
  if (blocked.length) {
    await env.DB.batch(blocked.map((id) => env.DB.prepare('UPDATE users SET blocked=1 WHERE id=?').bind(id)));
  }
  if (finished && n.author_id) {
    const t = await one(env, 'SELECT sent FROM news WHERE id=?', n.id);
    await send(env, n.author_id, `✅ Рассылка завершена. Доставлено: ${t.sent}`);
  }
}

// ---------- Сообщения ----------
async function onMessage(env, ctx, m) {
  if (m.chat.type !== 'private') return;
  const user = await touchUser(env, m.from);
  const c = { chat: m.chat.id, from: m.from, user };
  const text = (m.text || '').trim();

  if (text.startsWith('/')) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/id') return send(env, c.chat, `Твой ID: <code>${m.from.id}</code>`);
    await setStep(env, m.from.id, null);
    if (cmd === '/admin') return adminPanel(env, c);
    if (cmd === '/panel') return leaderPanel(env, c);
    return mainMenu(env, c);
  }
  if (!user.step) return mainMenu(env, c);
  const data = user.data ? JSON.parse(user.data) : {};
  return onStep(env, ctx, c, m, text, user.step, data);
}

async function onStep(env, ctx, c, m, text, step, data) {
  const uid = c.from.id;
  const panelBtn = [[btn('🛠 Панель', 'panel')]];
  const ask = (t) => send(env, c.chat, t, CANCEL);

  // --- шаги обычных пользователей ---
  if (step === 'create_name') {
    if (text.length < 3 || text.length > 40) return ask('Название должно быть от 3 до 40 символов. Попробуй ещё раз:');
    if (await one(env, 'SELECT 1 x FROM states WHERE name_key=?', text.toLowerCase())) return ask('Такое название уже занято. Придумай другое:');
    await setStep(env, uid, 'create_desc', { name: text });
    return ask('Теперь коротко опиши государство (или отправь «-», чтобы пропустить):');
  }
  if (step === 'create_desc') {
    if (!text) return ask('Отправь текстом описание или «-».');
    const r = await run(env, "INSERT INTO requests(kind, user_id, name, description) VALUES('create',?,?,?)",
      uid, data.name, text === '-' ? '' : text.slice(0, 500));
    await setStep(env, uid, null);
    await send(env, c.chat, '✅ Заявка отправлена администрации. Я сообщу о решении.', BACK);
    return notifyRequest(env, r.meta.last_row_id);
  }

  // --- шаги админа ---
  if (step.startsWith('a_')) {
    if (!(await isAdmin(env, c.from))) return setStep(env, uid, null);
    const back = [[btn('👑 Админ-панель', 'a')]];
    if (step === 'a_mk_name') {
      if (text.length < 3 || text.length > 40) return ask('Название от 3 до 40 символов:');
      await setStep(env, uid, 'a_mk_leader', { name: text });
      return ask('Кто будет лидером? Отправь @username или числовой ID (человек должен был нажать /start в боте). Или напиши «я».');
    }
    if (step === 'a_mk_leader') {
      const u = /^(я|me)$/i.test(text) ? c.user : await findUser(env, text);
      if (!u) return ask('Не нашёл такого пользователя. Он должен сначала нажать /start в боте. Попробуй ещё раз:');
      const r = await createState(env, u.id, data.name, '');
      if (r.error) return ask('Не получилось: ' + r.error + '. Отправь другого лидера:');
      await setStep(env, uid, null);
      if (u.id !== uid) await send(env, u.id, `🎉 Тебе выдали государство <b>${esc(data.name)}</b>! Открой /panel`);
      return send(env, c.chat, `✅ Государство «${esc(data.name)}» создано.`, back);
    }
    if (step === 'a_addadm') {
      if (!isOwner(env, c.from)) return setStep(env, uid, null);
      const u = await findUser(env, text);
      if (!u) return ask('Не нашёл. Человек должен нажать /start в боте. Попробуй ещё раз:');
      await run(env, 'INSERT OR IGNORE INTO admins(user_id) VALUES(?)', u.id);
      await setStep(env, uid, null);
      await send(env, u.id, '👮 Тебя назначили админом бота. Открой /admin');
      return send(env, c.chat, '✅ Админ добавлен.', back);
    }
    if (step === 'a_bc') {
      await queueNews(env, m, '📣 <b>Объявление администрации</b>', uid, null);
      await setStep(env, uid, null);
      ctx.waitUntil(processNews(env));
      return send(env, c.chat, '📤 Рассылка запущена. Пришлю отчёт, когда закончится.', back);
    }
  }

  // --- шаги лидера государства ---
  const st = await myState(env, uid);
  if (!st) return setStep(env, uid, null);

  if (step === 'p_news') {
    await queueNews(env, m, `📰 <b>Новость · ${esc(st.name)}</b>`, uid, st.id);
    await setStep(env, uid, null);
    ctx.waitUntil(processNews(env));
    return send(env, c.chat, '📤 Рассылка запущена. Пришлю отчёт, когда закончится.', panelBtn);
  }
  if (step === 'p_wth') {
    await run(env, 'UPDATE states SET weather=? WHERE id=?', text === '-' ? '' : text.slice(0, 200), st.id);
    await setStep(env, uid, null);
    return send(env, c.chat, '✅ Погода обновлена.', panelBtn);
  }
  if (step === 'p_desc') {
    if (!text) return ask('Отправь текстом.');
    await run(env, 'UPDATE states SET description=? WHERE id=?', text.slice(0, 500), st.id);
    await setStep(env, uid, null);
    return send(env, c.chat, '✅ Описание обновлено.', panelBtn);
  }
  if (step === 'p_post_t') {
    if (!text || text.length > 80) return ask('Название до 80 символов. Попробуй ещё раз:');
    await setStep(env, uid, 'p_post_b', { kind: data.kind, title: text });
    return ask('Теперь текст (до 3500 символов):');
  }
  if (step === 'p_post_b') {
    if (!text || text.length > 3500) return ask('Нужен текст до 3500 символов. Попробуй ещё раз:');
    await run(env, 'INSERT INTO posts(state_id, kind, title, body) VALUES(?,?,?,?)', st.id, data.kind, data.title, text);
    await setStep(env, uid, null);
    return send(env, c.chat, '✅ Опубликовано.', panelBtn);
  }
  if (step === 'p_html') {
    const d = m.document;
    if (!d || !/\.html?$/i.test(d.file_name || '')) return ask('Нужен файл с расширением .html — отправь его как документ:');
    await run(env, 'UPDATE states SET html_file_id=?, html_name=? WHERE id=?', d.file_id, d.file_name, st.id);
    await setStep(env, uid, null);
    return send(env, c.chat, '✅ HTML-файл сохранён. Его получат только участники твоего государства.', panelBtn);
  }
  return setStep(env, uid, null);
}

// ---------- Кнопки ----------
const PROMPTS = {
  p_news: ['p_news', '📰 Отправь новость: текст или фото/видео/файл с подписью. Её получат ВСЕ пользователи бота.'],
  p_wth: ['p_wth', '🌤 Напиши погоду в государстве (например: «☀️ +24, ясно»). «-» — убрать.'],
  p_art: ['p_post_t', '📄 Название статьи:'],
  p_law: ['p_post_t', '⚖️ Название закона:'],
  p_html: ['p_html', '🌐 Отправь .html файл с расширенной информацией о государстве (как документ).'],
  p_desc: ['p_desc', '✏️ Напиши новое описание:'],
};

async function onCallback(env, ctx, cq) {
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!cq.message || cq.message.chat.type !== 'private') return;
  const user = await touchUser(env, cq.from);
  const c = { chat: cq.message.chat.id, mid: cq.message.message_id, from: cq.from, user };
  const uid = cq.from.id;
  const [cmd, a, b] = (cq.data || '').split(':');
  const admin = await isAdmin(env, cq.from);
  const owner = isOwner(env, cq.from);

  if ((cmd === 'a' || cmd.startsWith('a_')) && !admin) return;

  switch (cmd) {
    case 'menu': case 'cancel':
      await setStep(env, uid, null);
      return mainMenu(env, c);

    case 'credits':
      return show(env, c, `💳 <b>Кредиты</b>\n\n@${esc(ownerName(env))} — создатель бота, принимает заявки.`, BACK);

    case 'create':
      if (await myState(env, uid)) return show(env, c, 'У тебя уже есть государство — открой «🛠 Панель государства».', BACK);
      if (await one(env, "SELECT 1 x FROM requests WHERE kind='create' AND user_id=? AND status='pending'", uid))
        return show(env, c, '⏳ Твоя заявка уже на рассмотрении. Дождись ответа.', BACK);
      await setStep(env, uid, 'create_name');
      return show(env, c, '🏛 Напиши название будущего государства (3–40 символов):', CANCEL);

    case 'join': {
      const rows = await all(env,
        `SELECT s.id, s.name, (SELECT COUNT(*) FROM members m WHERE m.state_id=s.id) n,
         EXISTS(SELECT 1 FROM members m WHERE m.state_id=s.id AND m.user_id=?) me
         FROM states s ORDER BY s.name LIMIT 50`, uid);
      if (!rows.length) return show(env, c, 'Пока нет ни одного государства.', BACK);
      const kb = rows.map((r) => [btn(`${r.me ? '✅ ' : ''}${r.name} (${r.n} граждн.)`, 'st:' + r.id)]);
      kb.push([btn('⬅️ В меню', 'menu')]);
      return show(env, c, '🚪 Выбери государство:', kb);
    }

    case 'st': return stateView(env, c, Number(a));

    case 'jr': {
      const s = await one(env, 'SELECT id, name FROM states WHERE id=?', Number(a));
      if (!s) return show(env, c, 'Государство не найдено.', BACK);
      await run(env, 'INSERT OR IGNORE INTO members(state_id, user_id) VALUES(?,?)', s.id, uid);
      return show(env, c, `🎉 Ты вступил в государство <b>${esc(s.name)}</b>!`,
        [[btn('🏛 Открыть', 'st:' + s.id)], [btn('⬅️ В меню', 'menu')]]);
    }

    case 'lv': {
      const s = await one(env, 'SELECT leader_id FROM states WHERE id=?', Number(a));
      if (s && s.leader_id === uid) return show(env, c, 'Лидер не может выйти из своего государства.', BACK);
      await run(env, 'DELETE FROM members WHERE state_id=? AND user_id=?', Number(a), uid);
      return show(env, c, '🚪 Ты вышел из государства.', BACK);
    }

    case 'pl': {
      const rows = await all(env, 'SELECT id, title FROM posts WHERE state_id=? AND kind=? ORDER BY id DESC LIMIT 40', Number(a), b);
      const kb = rows.map((r) => [btn(r.title.slice(0, 60), 'po:' + r.id)]);
      kb.push([btn('⬅️ Назад', 'st:' + a)]);
      const title = b === 'a' ? '📄 Статьи' : '⚖️ Законы';
      return show(env, c, rows.length ? title : `${title}: пока пусто.`, kb);
    }
    case 'po': {
      const p = await one(env, 'SELECT * FROM posts WHERE id=?', Number(a));
      if (!p) return show(env, c, 'Не найдено.', BACK);
      return show(env, c, `<b>${esc(p.title)}</b>\n\n${esc(p.body)}`, [[btn('⬅️ Назад', `pl:${p.state_id}:${p.kind}`)]]);
    }

    case 'html': {
      const s = await one(env, 'SELECT * FROM states WHERE id=?', Number(a));
      const mem = await one(env, 'SELECT 1 x FROM members WHERE state_id=? AND user_id=?', Number(a), uid);
      if (!s || !mem) return send(env, c.chat, '🔒 HTML-страница доступна только участникам государства.');
      if (!s.html_file_id) return send(env, c.chat, 'У государства пока нет HTML-страницы.');
      return tg(env, 'sendDocument', { chat_id: c.chat, document: s.html_file_id, caption: `🌐 ${s.name}` });
    }

    // ----- заявки -----
    case 'rq_ok': case 'rq_no': {
      const r = await one(env, 'SELECT * FROM requests WHERE id=?', Number(a));
      if (!r) return show(env, c, 'Заявка не найдена.');
      if (!admin) return;
      if (r.status !== 'pending') return show(env, c, `Заявка #${r.id} уже обработана.`);

      if (cmd === 'rq_no') {
        await run(env, "UPDATE requests SET status='rejected' WHERE id=?", r.id);
        await send(env, r.user_id, `❌ Заявка на создание «${esc(r.name)}» отклонена.`);
        return show(env, c, `Заявка #${r.id} отклонена ❌`);
      }
      const res = await createState(env, r.user_id, r.name, r.description);
      if (res.error) return show(env, c, `Не удалось принять заявку #${r.id}: ${res.error}.`);
      await send(env, r.user_id, `🎉 Заявка одобрена! Государство <b>${esc(r.name)}</b> создано. Открой /panel`);
      await run(env, "UPDATE requests SET status='approved' WHERE id=?", r.id);
      return show(env, c, `Заявка #${r.id} принята ✅`);
    }

    // ----- панель лидера -----
    case 'panel': return leaderPanel(env, c);

    case 'p_news': case 'p_wth': case 'p_art': case 'p_law': case 'p_html': case 'p_desc': {
      if (!(await myState(env, uid))) return show(env, c, 'У тебя нет государства.', BACK);
      const [step, prompt] = PROMPTS[cmd];
      await setStep(env, uid, step, step === 'p_post_t' ? { kind: cmd === 'p_art' ? 'a' : 'l' } : {});
      return show(env, c, prompt, CANCEL);
    }
    case 'p_mem': {
      const st = await myState(env, uid);
      if (!st) return;
      const rows = await all(env,
        'SELECT u.first_name n, u.username un FROM members m JOIN users u ON u.id=m.user_id WHERE m.state_id=? LIMIT 50', st.id);
      const list = rows.map((r) => `• ${esc(r.n)}${r.un ? ' @' + esc(r.un) : ''}`).join('\n');
      return show(env, c, `👥 <b>Граждане</b> (${rows.length})\n\n${list}`, [[btn('⬅️ Панель', 'panel')]]);
    }
    case 'pm': {
      const st = await myState(env, uid);
      return st ? postsManage(env, c, st) : undefined;
    }
    case 'pd': {
      const st = await myState(env, uid);
      if (!st) return;
      await run(env, 'DELETE FROM posts WHERE id=? AND state_id=?', Number(a), st.id);
      return postsManage(env, c, st);
    }

    // ----- админ-панель -----
    case 'a': return adminPanel(env, c);

    case 'a_req': {
      const rows = await all(env, "SELECT * FROM requests WHERE status='pending' ORDER BY id LIMIT 10");
      const back = [[btn('⬅️ Админ-панель', 'a')]];
      if (!rows.length) return show(env, c, 'Новых заявок нет 🎉', back);
      await show(env, c, `📥 Заявки в ожидании (показано ${rows.length}):`, back);
      for (const r of rows) {
        const [t, kb] = await requestCard(env, r);
        await send(env, c.chat, t, kb);
      }
      return;
    }
    case 'a_states': {
      const rows = await all(env, 'SELECT id, name FROM states ORDER BY name LIMIT 50');
      const kb = rows.map((r) => [btn('🗑 ' + r.name, 'a_del:' + r.id)]);
      kb.push([btn('⬅️ Админ-панель', 'a')]);
      return show(env, c, rows.length ? '🏛 Нажми на государство, чтобы удалить:' : 'Государств пока нет.', kb);
    }
    case 'a_del': {
      const s = await one(env, 'SELECT name FROM states WHERE id=?', Number(a));
      if (!s) return show(env, c, 'Уже удалено.', [[btn('⬅️ Назад', 'a_states')]]);
      return show(env, c, `Удалить государство «${esc(s.name)}»? Это необратимо.`,
        [[btn('✅ Да, удалить', 'a_delok:' + a), btn('Отмена', 'a_states')]]);
    }
    case 'a_delok': {
      const id = Number(a);
      const s = await one(env, 'SELECT * FROM states WHERE id=?', id);
      if (!s) return show(env, c, 'Уже удалено.', [[btn('⬅️ Назад', 'a_states')]]);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM members WHERE state_id=?').bind(id),
        env.DB.prepare('DELETE FROM posts WHERE state_id=?').bind(id),
        env.DB.prepare('DELETE FROM requests WHERE state_id=?').bind(id),
        env.DB.prepare('DELETE FROM states WHERE id=?').bind(id),
      ]);
      await send(env, s.leader_id, `⚠️ Твоё государство «${esc(s.name)}» удалено администрацией.`);
      return show(env, c, `🗑 Государство «${esc(s.name)}» удалено.`, [[btn('⬅️ К списку', 'a_states')]]);
    }
    case 'a_mk':
      await setStep(env, uid, 'a_mk_name');
      return show(env, c, '➕ Название нового государства:', CANCEL);

    case 'a_adm': return adminsView(env, c, owner);
    case 'a_addadm':
      if (!owner) return;
      await setStep(env, uid, 'a_addadm');
      return show(env, c, 'Отправь @username или числовой ID нового админа (он должен нажать /start в боте):', CANCEL);
    case 'a_rm':
      if (!owner) return;
      await run(env, 'DELETE FROM admins WHERE user_id=?', Number(a));
      return adminsView(env, c, owner);

    case 'a_bc':
      await setStep(env, uid, 'a_bc');
      return show(env, c, '📣 Отправь объявление (текст или медиа с подписью) — получат все пользователи:', CANCEL);

    case 'a_stats': {
      const s = await one(env,
        `SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM states) s,
                (SELECT COUNT(*) FROM members) m, (SELECT COUNT(*) FROM requests WHERE status='pending') r`);
      return show(env, c, `📊 Пользователей: ${s.u}\n🏛 Государств: ${s.s}\n👥 Вступлений: ${s.m}\n📥 Заявок в ожидании: ${s.r}`,
        [[btn('⬅️ Админ-панель', 'a')]]);
    }
  }
}

// ---------- Точка входа Worker ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Открой один раз в браузере: https://ТВОЙ-ВОРКЕР/setup?key=WEBHOOK_SECRET
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const r = await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      });
      return new Response(JSON.stringify(r, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const update = await req.json();
      const job = update.callback_query
        ? onCallback(env, ctx, update.callback_query)
        : update.message ? onMessage(env, ctx, update.message) : null;
      if (job) ctx.waitUntil(job.catch((e) => console.error(e)));
      return new Response('ok');
    }
    return new Response('Bot is running');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processNews(env));
  },
};
