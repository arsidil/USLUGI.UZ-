const { Telegraf, Markup } = require('telegraf');

// ─── КОНФИГУРАЦИЯ ─────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://sqsbqsizbzcddbzbaigw.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxc2Jxc2l6YnpjZGRiemJhaWd3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDEwNTkyOCwiZXhwIjoyMDg5NjgxOTI4fQ.IX0mzMND498fXhaYQ3RUgkp-1OIw_6PLU9xiJGtgOF4';

const BOT_TOKEN      = process.env.BOT_TOKEN || '8626567698:AAHuhRM4wHuc4_HerFbem1mD_WXTHv6e9v8';
const MAIN_BOT_TOKEN = process.env.MAIN_BOT_TOKEN || '';
const ADMIN_ID       = 1147754219;
const ADMIN_PASSWORD = 'USLUGI 1207';

// ✅ ЗАЩИТА ОТ RATE-LIMIT: задержка между каждым сообщением рассылки (мс)
// Telegram позволяет ~30 сообщений/сек глобально, ~1 msg/сек одному юзеру
// 50ms = ~20 сообщений/сек — безопасно для рассылок до ~1000 пользователей
// Для > 1000 пользователей рекомендуется увеличить до 100-150ms
const BROADCAST_DELAY = 50;

// ─── SUPABASE АБСТРАКЦИЯ ──────────────────────────────────────────────────────
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
  if (!res.ok) { 
    const e = await res.text(); 
    throw new Error(`Supabase ${res.status}: ${e}`); 
  }
  const t = await res.text(); 
  return t ? JSON.parse(t) : null;
}

const db = {
  select: (tbl, p = '') => sbFetch(`/rest/v1/${tbl}?${p}`, { 
    method: 'GET', 
    headers: { 'Prefer': 'return=representation' } 
  }),
  update: (tbl, f, d) => sbFetch(`/rest/v1/${tbl}?${f}`, { 
    method: 'PATCH', 
    headers: { 'Prefer': 'return=representation' }, 
    body: JSON.stringify(d) 
  }),
  delete: (tbl, f) => sbFetch(`/rest/v1/${tbl}?${f}`, { method: 'DELETE' })
};

// ─── ЗАГРУЗКА ФОТО НА SUPABASE STORAGE ──────────────────────────────────────
// Скачивает фото через админ-бот и загружает в Supabase, возвращает публичный URL
async function uploadBroadcastPhoto(fileId) {
  // 1. Получаем путь к файлу через API админ-бота
  const infoRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const infoJson = await infoRes.json();
  if (!infoJson.ok) throw new Error('getFile failed: ' + infoJson.description);
  const filePath = infoJson.result.file_path;

  // 2. Скачиваем файл
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
  );
  if (!fileRes.ok) throw new Error('Download failed');
  const buffer = await fileRes.arrayBuffer();

  // 3. Загружаем в Supabase Storage (бакет broadcast-photos)
  const ext = filePath.split('.').pop() || 'jpg';
  const storagePath = `public/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/broadcast-photos/${storagePath}`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'false'
      },
      body: buffer
    }
  );
  if (!uploadRes.ok) {
    const e = await uploadRes.text();
    throw new Error('Upload failed: ' + e);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/broadcast-photos/${storagePath}`;
}

// ─── ОТПРАВКА В ОСНОВНОЙ БОТ ──────────────────────────────────────────────────
// photoUrl — публичный URL (Supabase), работает в любом боте
async function mainBotSend(chatId, text, photoUrl = null) {
  if (!MAIN_BOT_TOKEN) throw new Error('MAIN_BOT_TOKEN не задан');

  const endpoint = photoUrl
    ? `https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendPhoto`
    : `https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendMessage`;
  
  const body = photoUrl
    ? { chat_id: chatId, photo: photoUrl, caption: text, parse_mode: 'HTML' }
    : { chat_id: chatId, text, parse_mode: 'HTML' };

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Telegram error');
  return j.result;
}

// ─── ИНИЦИАЛИЗАЦИЯ БОТА ───────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const authedAdmins = new Set();

// Состояние рассылки
const broadcastState = {
  text: null,
  photoFileId: null,   // ✅ храним file_id, а не временный URL
  isAwaitingText: false,
  isAwaitingPhoto: false
};

const ACTION_RE = /^(approve|reject|delete)_(.+)$/;

// ─── MIDDLEWARE: КОНТРОЛЬ ДОСТУПА ──────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.id !== ADMIN_ID) {
    if (ctx.message && ctx.chat?.type === 'private') {
      await ctx.reply('⛔ Нет доступа').catch(() => {});
    }
    return;
  }
  return next();
});

// ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ──────────────────────────────────────────────────
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Ожидают проверки', 'pending_apps')],
    [Markup.button.callback('✅ Одобренные', 'approved_apps')],
    [Markup.button.callback('❌ Отклонённые', 'rejected_apps')],
    [Markup.button.callback('📢 Рассылка', 'do_broadcast')]
  ]);
}

function showMenu(ctx) {
  return ctx.reply('👋 <b>USLUGI.UZ — Админ панель</b>\n\nВыбери действие:', {
    parse_mode: 'HTML',
    ...mainMenu()
  });
}

function fmtService(d) {
  const verified = d.verified ? ' ✅' : '';
  const docMark = d.document_url ? ' 📄' : '';
  
  return `🚨 НОВАЯ ЗАЯВКА${verified}${docMark}\n\n👤 ${d.name}\n📂 ${d.category}` +
    (d.specialty   ? `\n🎯 ${d.specialty}`   : '') +
    (d.phone       ? `\n📞 ${d.phone}`        : '') +
    (d.telegram    ? `\n✈️ @${d.telegram}`    : '') +
    (d.description ? `\n📝 ${d.description}`  : '');
}

// ─── ОТПРАВКА ЗАЯВКИ АДМИНИСТРАТОРУ ───────────────────────────────────────────
async function sendServiceToAdmin(d) {
  const text = fmtService(d);
  const keyboard = Markup.inlineKeyboard([[
    Markup.button.callback('✅ Одобрить', `approve_${d.id}`),
    Markup.button.callback('❌ Отклонить', `reject_${d.id}`)
  ]]);

  try {
    // Основное сообщение — с фото профиля если есть
    if (d.photo_url) {
      await bot.telegram.sendPhoto(ADMIN_ID, d.photo_url, {
        caption: text,
        parse_mode: 'HTML',
        ...keyboard
      });
    } else {
      await bot.telegram.sendMessage(ADMIN_ID, text, {
        parse_mode: 'HTML',
        ...keyboard
      });
    }

    // ✅ Документ подтверждения (отдельным сообщением)
    if (d.document_url) {
      // Сначала пробуем как документ (PDF, doc, etc.)
      try {
        await bot.telegram.sendDocument(ADMIN_ID, d.document_url, {
          caption: '📄 Документ подтверждения квалификации'
        });
      } catch {
        // Если не документ — пробуем как фото (jpg, png)
        try {
          await bot.telegram.sendPhoto(ADMIN_ID, d.document_url, {
            caption: '📸 Документ подтверждения (фото)'
          });
        } catch {
          // Последний фолбек — просто ссылка
          await bot.telegram.sendMessage(ADMIN_ID, `📄 Документ: ${d.document_url}`);
        }
      }
    }
  } catch (e) {
    console.error('sendServiceToAdmin error:', e.message);
  }
}

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────
bot.start(ctx => {
  if (!authedAdmins.has(ctx.from.id)) {
    return ctx.reply('🔐 <b>USLUGI.UZ — Админ</b>\n\nВведите пароль:', { 
      parse_mode: 'HTML' 
    });
  }
  return showMenu(ctx);
});

bot.command('help', ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль. /start');
  return ctx.reply(
    `📖 <b>Справка</b>\n\n/pending — заявки с кнопками\n/list — одобренные с кнопкой удаления\n/broadcast — рассылка\n/cancel — отмена`,
    { parse_mode: 'HTML' }
  );
});

bot.command('pending', async ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль.');
  try {
    const rows = await db.select('services', 'status=eq.pending&order=created_at.asc');
    if (!rows || !rows.length) return ctx.reply('✅ Нет ожидающих заявок');
    
    await ctx.reply(`📋 Ожидают: ${rows.length}`);
    for (const d of rows) {
      await sendServiceToAdmin(d);
    }
  } catch (e) { 
    ctx.reply('❌ Ошибка: ' + e.message); 
  }
});

bot.command('list', async ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль.');
  try {
    const rows = await db.select('services', 'status=eq.approved&order=created_at.desc');
    if (!rows || !rows.length) return ctx.reply('📭 Нет одобренных анкет');
    
    await ctx.reply(`📋 Одобренных: ${rows.length}`);
    for (const d of rows) {
      const verified = d.verified ? ' ✅' : '';
      const ph = d.phone    ? `\n📞 ${d.phone}`     : '';
      const tg = d.telegram ? `\n✈️ @${d.telegram}` : '';
      const sp = d.specialty ? ` — ${d.specialty}`  : '';
      
      await bot.telegram.sendMessage(ADMIN_ID,
        `👤 ${d.name}${verified}\n📂 ${d.category}${sp}${ph}${tg}`,
        { 
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('🗑 Удалить', `delete_${d.id}`)
          ]]) 
        }
      );
    }
  } catch (e) { 
    ctx.reply('❌ Ошибка: ' + e.message); 
  }
});

bot.command('broadcast', ctx => {
  if (!authedAdmins.has(ctx.from.id)) return ctx.reply('🔐 Введите пароль.');
  
  broadcastState.isAwaitingText = true;
  broadcastState.isAwaitingPhoto = false;
  broadcastState.text = null;
  broadcastState.photoFileId = null;
  
  return ctx.reply('📢 Введите текст рассылки:\n\n/cancel — отмена');
});

bot.command('cancel', ctx => {
  broadcastState.isAwaitingText = false;
  broadcastState.isAwaitingPhoto = false;
  broadcastState.text = null;
  broadcastState.photoFileId = null;
  return ctx.reply('✅ Отменено.');
});

// ─── ОБРАБОТКА ТЕКСТА (пароль / текст рассылки) ────────────────────────────────
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

  // Ввод текста рассылки
  if (broadcastState.isAwaitingText && !broadcastState.text) {
    broadcastState.text = ctx.message.text.trim();
    broadcastState.isAwaitingText = false;
    broadcastState.isAwaitingPhoto = false;
    
    return ctx.reply(
      `📋 <b>Черновик:</b>\n\n${broadcastState.text}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📢 Без фото', 'broadcast_send')],
          [Markup.button.callback('📸 Добавить фото', 'broadcast_await_photo')],
          [Markup.button.callback('✏️ Изменить', 'broadcast_edit')],
          [Markup.button.callback('🗑 Отмена', 'broadcast_cancel')]
        ])
      }
    );
  }

  return next();
});

// ─── ОБРАБОТКА ФОТО ДЛЯ РАССЫЛКИ ──────────────────────────────────────────────
// ✅ Теперь принимаем и обычное фото и документ-фото (без сжатия)
bot.on(['photo', 'document'], async ctx => {
  if (!authedAdmins.has(ctx.from.id)) return;
  if (!broadcastState.isAwaitingPhoto || !broadcastState.text) return;

  let fileId;

  if (ctx.message.photo) {
    // Берём самое качественное фото из массива
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  } else if (ctx.message.document && ctx.message.document.mime_type?.startsWith('image/')) {
    // Документ-фото (отправлено без сжатия)
    fileId = ctx.message.document.file_id;
  } else {
    return ctx.reply('❌ Пожалуйста, отправьте изображение (фото или картинку как файл).');
  }

  broadcastState.photoFileId = fileId;
  broadcastState.isAwaitingPhoto = false;

  return ctx.reply(
    `✅ Фото добавлено!\n\n📋 <b>Черновик:</b>\n${broadcastState.text}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📢 Разослать', 'broadcast_send')],
        [Markup.button.callback('🖼 Изменить фото', 'broadcast_await_photo')],
        [Markup.button.callback('✏️ Изменить текст', 'broadcast_edit')],
        [Markup.button.callback('🗑 Отмена', 'broadcast_cancel')]
      ])
    }
  );
});

// ─── ЭКШЕНЫ РАССЫЛКИ ──────────────────────────────────────────────────────────
bot.action('do_broadcast', async ctx => {
  await ctx.answerCbQuery();
  broadcastState.isAwaitingText = true;
  broadcastState.isAwaitingPhoto = false;
  broadcastState.text = null;
  broadcastState.photoFileId = null;
  return ctx.reply('📢 Введите текст рассылки:\n\n/cancel — отмена');
});

bot.action('broadcast_await_photo', async ctx => {
  await ctx.answerCbQuery();
  broadcastState.isAwaitingPhoto = true;
  return ctx.reply('📸 Отправьте фото (или как файл без сжатия). /cancel — отмена');
});

bot.action('broadcast_send', async ctx => {
  await ctx.answerCbQuery();
  
  if (!broadcastState.text) {
    return ctx.reply('❌ Нет текста.');
  }
  if (!MAIN_BOT_TOKEN) {
    return ctx.reply('❌ MAIN_BOT_TOKEN не задан');
  }

  let users = [];
  try {
    users = await db.select('users', 'select=chat_id');
  } catch (e) {
    return ctx.reply('❌ Ошибка получения пользователей: ' + e.message);
  }
  
  if (!users || !users.length) {
    return ctx.reply('❌ Нет пользователей');
  }

  const msgId = (await ctx.reply(
    `📢 Рассылка ${users.length} пользователям...\n\n0/${users.length}`
  )).message_id;
  
  let ok = 0, fail = 0;
  const text = broadcastState.text;
  const photoFileId = broadcastState.photoFileId;
  
  // Сбрасываем состояние перед рассылкой
  broadcastState.text = null;
  broadcastState.photoFileId = null;
  broadcastState.isAwaitingText = false;
  broadcastState.isAwaitingPhoto = false;

  // Загружаем фото на Supabase один раз — URL работает в любом боте
  let photoUrl = null;
  if (photoFileId) {
    try {
      await ctx.reply('⏳ Загружаю фото...');
      photoUrl = await uploadBroadcastPhoto(photoFileId);
    } catch (e) {
      console.warn('Photo upload error:', e.message);
      await ctx.reply('⚠️ Не удалось загрузить фото, рассылка будет без фото.');
    }
  }

  for (let i = 0; i < users.length; i++) {
    try {
      await mainBotSend(users[i].chat_id, text, photoUrl);
      ok++;
    } catch (e) {
      fail++;
      console.warn(`broadcast fail ${users[i].chat_id}:`, e.message);
    }
    
    // Обновляем счётчик каждые 10 сообщений
    if ((i + 1) % 10 === 0) {
      try {
        await bot.telegram.editMessageText(
          ADMIN_ID,
          msgId,
          undefined,
          `📢 Рассылка ${users.length} пользователям...\n\n${i + 1}/${users.length}`
        );
      } catch {}
    }
    
    // ✅ Задержка для защиты от rate-limit Telegram (30 msg/sec лимит)
    await new Promise(resolve => setTimeout(resolve, BROADCAST_DELAY));
  }

  return ctx.reply(`✅ Готово.\n📤 Отправлено: ${ok}\n❌ Ошибки: ${fail}`);
});

bot.action('broadcast_edit', async ctx => {
  await ctx.answerCbQuery();
  broadcastState.isAwaitingText = true;
  broadcastState.isAwaitingPhoto = false;
  return ctx.reply('✏️ Введите новый текст:');
});

bot.action('broadcast_cancel', async ctx => {
  await ctx.answerCbQuery();
  broadcastState.text = null;
  broadcastState.photoFileId = null;
  broadcastState.isAwaitingText = false;
  broadcastState.isAwaitingPhoto = false;
  return ctx.editMessageText('🗑 Рассылка отменена.');
});

// ─── INLINE-КНОПКИ: МЕНЮ ──────────────────────────────────────────────────────
bot.action('pending_apps', async ctx => {
  await ctx.answerCbQuery();
  try {
    const rows = await db.select('services', 'status=eq.pending&order=created_at.asc');
    if (!rows || !rows.length) return ctx.reply('✅ Нет ожидающих заявок');
    await ctx.reply(`📋 Ожидают: ${rows.length}`);
    for (const d of rows) await sendServiceToAdmin(d);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
});

bot.action('approved_apps', async ctx => {
  await ctx.answerCbQuery();
  try {
    const rows = await db.select('services', 'status=eq.approved&order=created_at.desc');
    if (!rows || !rows.length) return ctx.reply('📭 Нет одобренных');
    await ctx.reply(`✅ Одобренных: ${rows.length}`);
    for (const d of rows) {
      const verified = d.verified ? ' ✅' : '';
      await bot.telegram.sendMessage(ADMIN_ID,
        `👤 ${d.name}${verified}\n📂 ${d.category}${d.specialty ? ' — ' + d.specialty : ''}`,
        { ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Удалить', `delete_${d.id}`)]]) }
      );
    }
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
});

bot.action('rejected_apps', async ctx => {
  await ctx.answerCbQuery();
  try {
    const rows = await db.select('services', 'status=eq.rejected&order=created_at.desc');
    if (!rows || !rows.length) return ctx.reply('📭 Нет отклонённых');
    await ctx.reply(`❌ Отклонённых: ${rows.length}`);
    for (const d of rows) {
      await bot.telegram.sendMessage(ADMIN_ID,
        `👤 ${d.name}\n📂 ${d.category}`,
        { ...Markup.inlineKeyboard([[Markup.button.callback('✅ Одобрить', `approve_${d.id}`)]]) }
      );
    }
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
});

// ─── ЭКШЕНЫ УПРАВЛЕНИЯ ЗАЯВКАМИ ───────────────────────────────────────────────
bot.on('callback_query', async (ctx, next) => {
  const data  = ctx.callbackQuery?.data || '';
  const match = data.match(ACTION_RE);
  if (!match) return next();

  await ctx.answerCbQuery();

  const action = match[1];
  const id = match[2];

  try {
    const rows = await db.select('services', `id=eq.${id}`);
    if (!rows || !rows.length) {
      return ctx.editMessageText('⚠️ Запись удалена');
    }
    const d = rows[0];

    if (action === 'approve') {
      const verified = !!d.document_url;
      await db.update('services', `id=eq.${id}`, { 
        status: 'approved', 
        verified 
      });

      // Уведомление специалисту через основной бот
      if (d.telegram && MAIN_BOT_TOKEN) {
        try {
          const uname = d.telegram.replace(/^@/, '').toLowerCase();
          const found = await db.select('users', `username=eq.${uname}&select=chat_id&limit=1`);
          if (found && found.length) {
            const verifyMsg = verified ? '\n\n✅ Ваш профиль получил галочку верификации!' : '';
            await mainBotSend(
              found[0].chat_id,
              `🎉 Ваша анкета одобрена!\n\nВы в каталоге USLUGI.UZ${verifyMsg}`
            );
          }
        } catch (e) {
          console.warn('Notify error:', e.message);
        }
      }

      const verMark = verified ? ' ✅' : '';
      return ctx.editMessageText(
        `✅ ОДОБРЕНО${verMark}\n\n👤 ${d.name}\n🎯 ${d.specialty || '—'}\n📂 ${d.category}`
      );
    }

    if (action === 'reject') {
      await db.update('services', `id=eq.${id}`, { status: 'rejected' });
      return ctx.editMessageText(`❌ ОТКЛОНЕНО\n👤 ${d.name}`);
    }

    if (action === 'delete') {
      try { 
        await db.delete('reviews', `service_id=eq.${id}`); 
      } catch {}
      await db.delete('services', `id=eq.${id}`);
      return ctx.editMessageText(`🗑 Удалено\n👤 ${d.name}`);
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
      await sendServiceToAdmin(d);
      console.log(`📨 Новая заявка: ${d.name} (${d.id})`);
    }
  } catch (e) { 
    console.error('Polling error:', e.message); 
  }
}

db.select('services', 'status=eq.pending')
  .then(rows => {
    if (rows) rows.forEach(r => seenIds.add(r.id));
    console.log(`📊 Pending на запуск: ${seenIds.size}`);
    setInterval(pollPending, 10_000);
  })
  .catch(() => setInterval(pollPending, 10_000));

// ─── СТАРТ ────────────────────────────────────────────────────────────────────
bot.launch();
console.log('✅ Админ-бот запущен');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
