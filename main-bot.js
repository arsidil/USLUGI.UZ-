/**
 * Основной пользовательский бот USLUGI.UZ
 * Открывает мини-приложение по кнопке.
 *
 * Переменные окружения (Railway):
 *   BOT_TOKEN    — токен основного бота
 *   WEB_APP_URL  — HTTPS-ссылка на index.html (Vercel)
 */
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN   = process.env.BOT_TOKEN || '';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://example.com/index.html';

if (!BOT_TOKEN) {
  console.error('❌ Задайте BOT_TOKEN в переменных окружения Railway.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const WELCOME_TEXT =
`👋 Добро пожаловать в *USLUGI.UZ*!

Здесь вы можете найти проверенных специалистов рядом с вами — за 2 минуты 💛

Нажмите кнопку ниже, чтобы открыть каталог:`;

const appButton = () => Markup.inlineKeyboard([
  [Markup.button.webApp('🔍 Открыть USLUGI.UZ', WEB_APP_URL)]
]);

bot.start(ctx =>
  ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...appButton() })
);

bot.command('help', ctx =>
  ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...appButton() })
);

// Любое другое сообщение — напоминаем про кнопку
bot.on('message', ctx =>
  ctx.reply('Нажмите кнопку, чтобы открыть каталог специалистов 👇', appButton())
);

bot.launch();
console.log('✅ Основной бот запущен');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
