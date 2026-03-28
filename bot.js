const { Telegraf, Markup } = require('telegraf');

// ─── КОНФИГ ───────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://sqsbqsizbzcddbzbaigw.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxc2Jxc2l6YnpjZGRiemJhaWd3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDEwNTkyOCwiZXhwIjoyMDg5NjgxOTI4fQ.IX0mzMND498fXhaYQ3RUgkp-1OIw_6PLU9xiJGtgOF4';

const BOT_TOKEN      = process.env.BOT_TOKEN || '8626567698:AAHuhRM4wHuc4_HerFbem1mD_WXTHv6e9v8';
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN || '';
const ADMIN_ID       = 1147754219;
const ADMIN_PASSWORD = 'USLUGI 1207';

// ─── SUPABASE ──────────────────────────────────────────────────────────────────
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 204) return null;
  if (!res.ok) { const e = await res.text(); throw new Error(`Supabase ${res.status}: ${e}`); }
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

const db = {
  select: (tbl, p = '') => sbFetch(`/rest/v1/${tbl}?${p}`, { method: 'GET', headers: { 'Prefer': 'return=representation' } }),
  update: (tbl, f, d)   => sbFetch(`/rest/v1/${tbl}?${f}`, { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify(d) }),
  delete: (tbl, f)      => sbFetch(`/rest/v1/${tbl}?${f}`, { method: 'DELETE' })
};

// ─── TELEGRAM API (основной бот для рассылки) ─────────────────────────────────
async function mainBotSend(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Telegram error');
  return j.result;
}

// ─── БОТ ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const authedAdmins = new Set();

let broadcastText    = null;
let broadcastWaiting = false;

const ACTION_RE = /^(approve|reject|delete)_(.+)$/;

// ─── MIDDLEWARE: только ADMIN_ID ───────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.id !== ADMIN_ID) {
    if (ctx.message && ctx.chat?.type === 'private') {
      await ctx.reply('⛔ Нет доступа').catch(() => {});
    }
    return;
  }
  return next();
});

// ─── ХЕЛПЕРЫ ──────────────────────────────────────────────────────────────────
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Ожидают проверки', 'pending_apps')],
    [Markup.button.callback('✅ Одобренные', 'approved_apps')],
    [Markup.button.callback('❌ Отклонённые', 'rejected_apps')],
    [Markup.button.callback('📢 Рассылка пользователям', 'do_broadcast')]
  ]);
}

function showMenu(ctx) {
  return ctx.reply('👋 *USLUGI.UZ — Админ панель*\n\nВыбери действие:', {
    parse_mode: 'Markdown',
    ...mainMenu()
  });
}

function fmtService(d) {
  return `🚨 *НОВАЯ ЗАЯВКА*\n\n👤 *${d.name}*\n📂 ${d.category}` +
    (d.specialty   ? `\n🎯 *${d.specialty}*`  : '') +
    (d.phone       ? `\n📞 *${d.phone}*`       : '') +
    (d.telegram    ? `\n✈️ @${d.telegram}`     : '') +
    (d.description ? `\n📝 ${d.description}`   : '');
}

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────
bot.start(ctx => {
  if (!authedAdmins.has(ctx.from.id)) {
    return ctx.reply('🔐 *USLUGI.UZ — Админ*\n\nВведите пароль:', { parse_mode: 'Markdown' });
  }
  return showMenu(ctx);
});

bot.command('help', ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль. /start');
  return ctx.reply(
    `📖 *Справка*\n\n/pending — заявки с кнопками\n/list — одобренные с кнопкой удаления\n/broadcast — рассылка всем\n/cancel — отменить ввод`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('pending', async ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль.');
  try {
    const rows = await db.select('services', 'status=eq.pending&order=created_at.asc');
    if (!rows || !rows.length) return ctx.reply('✅ Нет ожидающих заявок');
    await ctx.reply(`📋 *Ожидают: ${rows.length}*`, { parse_mode: 'Markdown' });
    for (const d of rows) {
      await bot.telegram.sendMessage(ADMIN_ID, fmtService(d), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('✅ Одобрить', `approve_${d.id}`),
          Markup.button.callback('❌ Отклонить', `reject_${d.id}`)
        ]])
      });
    }
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
});

bot.command('list', async ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль.');
  try {
    const rows = await db.select('services', 'status=eq.approved&order=created_at.desc');
    if (!rows || !rows.length) return ctx.reply('📭 Нет одобренных анкет');
    await ctx.reply(`📋 *Одобренных: ${rows.length}*`, { parse_mode: 'Markdown' });
    for (const d of rows) {
      const ph = d.phone    ? `\n📞 ${d.phone}`     : '';
      const tg = d.telegram ? `\n✈️ @${d.telegram}` : '';
      const sp = d.specialty ? ` — ${d.specialty}`  : '';
      await bot.telegram.sendMessage(ADMIN_ID,
        `👤 *${d.name}*\n📂 ${d.category}${sp}${ph}${tg}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Удалить анкету', `delete_${d.id}`)]]) }
      );
    }
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
});

bot.command('broadcast', ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль.');
  broadcastWaiting = true;
  broadcastText    = null;
  return ctx.reply('📢 Введите текст рассылки.\n/cancel — отмена');
});

bot.command('cancel', ctx => {
  broadcastWaiting = false;
  broadcastText    = null;
  return ctx.reply('✅ Отменено.');
});

// ─── ТЕКСТ (пароль / черновик рассылки) ───────────────────────────────────────
bot.on('text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) return next();

  if (!authedAdmins.has(ctx.from.id)) {
    if (ctx.message.text.trim() === ADMIN_PASSWORD) {
      authedAdmins.add(ctx.from.id);
      await ctx.reply('✅ Пароль принят.');
      return showMenu(ctx);
    }
    return ctx.reply('❌ Неверный пароль.');
  }

  if (broadcastWaiting) {
    broadcastText    = ctx.message.text.trim();
    broadcastWaiting = false;
    return ctx.reply(
      `📋 *Черновик рассылки:*\n\n${broadcastText}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📢 Разослать всем', 'broadcast_send')],
          [Markup.button.callback('✏️ Изменить', 'broadcast_edit'), Markup.button.callback('🗑 Отмена', 'broadcast_cancel')]
        ])
      }
    );
  }

  return next();
});

// ─── INLINE КНОПКИ МЕНЮ ───────────────────────────────────────────────────────
bot.action('main_menu', async ctx => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('👋 *USLUGI.UZ — Админ панель*\n\nВыбери действие:', {
    parse_mode: 'Markdown',
    ...mainMenu()
  });
});

bot.action('pending_apps', async ctx => {
  await ctx.answerCbQuery();
  try {
    const rows = await db.select('services', 'status=eq.pending&order=created_at.asc');
    if (!rows || !rows.length) {
      return ctx.editMessageText('✅ Нет новых заявок', Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Обновить', 'pending_apps')],
        [Markup.button.callback('🏠 Главная', 'main_menu')]
      ]));
    }
    return ctx.editMessageText(
      `📋 *Ожидают: ${rows.length}*\n\nОтправь /pending чтобы увидеть их с кнопками`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить', 'pending_apps')], [Markup.button.callback('🏠 Главная', 'main_menu')]]) }
    );
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

bot.action('approved_apps', async ctx => {
  await ctx.answerCbQuery();
  try {
    const rows = await db.select('services', 'status=eq.approved&order=created_at.desc');
    if (!rows || !rows.length) return ctx.editMessageText('Нет одобренных', Markup.inlineKeyboard([[Markup.button.callback('🏠 Главная', 'main_menu')]]));
    let text = `✅ *Одобренных: ${rows.length}*\n\n`;
    rows.forEach(d => { text += `• *${d.name}* — ${d.specialty || d.category}\n`; });
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главная', 'main_menu')]]) });
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

bot.action('rejected_apps', async ctx => {
  await ctx.answerCbQuery();
  try {
    const rows = await db.select('services', 'status=eq.rejected&order=created_at.desc');
    if (!rows || !rows.length) return ctx.editMessageText('Нет отклонённых', Markup.inlineKeyboard([[Markup.button.callback('🏠 Главная', 'main_menu')]]));
    let text = `❌ *Отклонённых: ${rows.length}*\n\n`;
    rows.forEach(d => { text += `• *${d.name}* — ${d.specialty || d.category}\n`; });
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Главная', 'main_menu')]]) });
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

// ─── РАССЫЛКА (кнопки) ────────────────────────────────────────────────────────
bot.action('do_broadcast', async ctx => {
  await ctx.answerCbQuery();
  broadcastWaiting = true;
  broadcastText    = null;
  return ctx.reply('📢 Введите текст рассылки.\n/cancel — отмена');
});

bot.action('broadcast_send', async ctx => {
  await ctx.answerCbQuery();
  if (!broadcastText) return ctx.reply('❌ Нет текста.');
  if (!MAIN_BOT_TOKEN) return ctx.reply('❌ Задайте MAIN_BOT_TOKEN в переменных окружения Railway (сервер админ-бота).');

  let users = [];
  try {
    users = await db.select('users', 'select=chat_id');
  } catch (e) {
    return ctx.reply('❌ Ошибка получения пользователей: ' + e.message);
  }
  if (!users || !users.length) return ctx.reply('❌ Нет пользователей. Никто ещё не запускал основной бот.');

  await ctx.editMessageText(`📢 Рассылаю ${users.length} пользователям...`);

  let ok = 0, fail = 0;
  const text = broadcastText;
  broadcastText = null;

  for (const u of users) {
    try {
      await mainBotSend(u.chat_id, text);
      ok++;
    } catch (e) {
      fail++;
      console.warn(`broadcast fail ${u.chat_id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 50));
  }

  return ctx.reply(`✅ Готово.\n📤 Отправлено: ${ok}\n❌ Не доставлено: ${fail}`);
});

bot.action('broadcast_edit', async ctx => {
  await ctx.answerCbQuery();
  broadcastWaiting = true;
  broadcastText    = null;
  return ctx.reply('✏️ Введите новый текст:');
});

bot.action('broadcast_cancel', async ctx => {
  await ctx.answerCbQuery();
  broadcastText    = null;
  broadcastWaiting = false;
  return ctx.editMessageText('🗑 Рассылка отменена.');
});

// ─── APPROVE / REJECT / DELETE ────────────────────────────────────────────────
bot.on('callback_query', async (ctx, next) => {
  const data  = ctx.callbackQuery?.data || '';
  const match = data.match(ACTION_RE);
  if (!match) return next();

  await ctx.answerCbQuery();

  const action = match[1];
  const id     = match[2];

  try {
    const rows = await db.select('services', `id=eq.${id}`);
    if (!rows || !rows.length) {
      return ctx.editMessageText('⚠️ Запись не найдена (уже удалена?)');
    }
    const d = rows[0];

    if (action === 'approve') {
      await db.update('services', `id=eq.${id}`, { status: 'approved' });
      return ctx.editMessageText(
        `✅ *ОДОБРЕНО*\n\n👤 ${d.name}\n🎯 ${d.specialty || '-'}\n📂 ${d.category}\n📞 ${d.phone || '-'}\n✈️ ${d.telegram ? '@' + d.telegram : '-'}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (action === 'reject') {
      await db.update('services', `id=eq.${id}`, { status: 'rejected' });
      return ctx.editMessageText(
        `❌ *ОТКЛОНЕНО*\n\n👤 ${d.name}\n🎯 ${d.specialty || '-'}\n📂 ${d.category}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (action === 'delete') {
      try { await db.delete('reviews', `service_id=eq.${id}`); } catch (_) {}
      await db.delete('services', `id=eq.${id}`);
      return ctx.editMessageText(`🗑 *Удалено*\n👤 ${d.name}`, { parse_mode: 'Markdown' });
    }

  } catch (e) {
    console.error(`${action} error:`, e.message);
    return ctx.reply('❌ Ошибка: ' + e.message.slice(0, 80));
  }
});

// ─── ПОЛЛИНГ НОВЫХ ЗАЯВОК ─────────────────────────────────────────────────────
const seenIds = new Set();

async function pollPending() {
  try {
    const rows = await db.select('services', 'status=eq.pending&order=created_at.asc');
    if (!rows || !rows.length) return;
    for (const d of rows) {
      if (seenIds.has(d.id)) continue;
      seenIds.add(d.id);
      await bot.telegram.sendMessage(ADMIN_ID, fmtService(d), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('✅ Одобрить', `approve_${d.id}`),
          Markup.button.callback('❌ Отклонить', `reject_${d.id}`)
        ]])
      });
      console.log(`📨 Новая заявка: ${d.name} (${d.id})`);
    }
  } catch (e) { console.error('Polling error:', e.message); }
}

db.select('services', 'status=eq.pending').then(rows => {
  if (rows) rows.forEach(r => seenIds.add(r.id));
  console.log(`📊 При запуске pending: ${seenIds.size}`);
  setInterval(pollPending, 10_000);
}).catch(() => setInterval(pollPending, 10_000));

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────
bot.launch();
console.log('✅ Админ-бот запущен');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
