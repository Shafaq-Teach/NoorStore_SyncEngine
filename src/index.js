import express from 'express';
import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { parseProductMessage } from './parser.js';
import { 
  downloadTelegramPhotoAsDataUrl, 
  insertProductToSupabase, 
  pushCloudSyncState, 
  fetchCloudCommands,
  getLocalProducts,
  saveLocalProducts
} from './supabaseSync.js';
import { 
  initWhatsAppClient, 
  resetWhatsAppAuth,
  refreshWhatsAppGroups,
  setSelectedGroup,
  selectedGroup,
  whatsappStatus, 
  latestQrDataUrl, 
  availableGroups, 
  sendProductToWhatsApp 
} from './whatsappSync.js';
import { restoreAuthFromCloud } from './authBackup.js';

process.on('uncaughtException', (err) => {
  console.log('[System Catch uncaughtException]:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('[System Catch unhandledRejection]:', reason?.message || reason);
});

const app = express();

// Enable CORS for Website & App
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let telegramBot = null;
let telegramStatus = 'NOT_CONFIGURED'; // 'NOT_CONFIGURED' | 'CONNECTED' | 'ERROR'
let syncedLogs = [];

// Cache to prevent duplicate processing from updates, webhooks, media groups, and echoes
const processedMessageKeys = new Set();
const processedMediaGroups = new Set();
const recentProductDebounce = new Map();

function isDuplicateMessage(chatId, messageId) {
  if (!chatId || !messageId) return false;
  const key = `${chatId}_${messageId}`;
  if (processedMessageKeys.has(key)) return true;
  processedMessageKeys.add(key);
  setTimeout(() => processedMessageKeys.delete(key), 60000);
  return false;
}

function isDuplicateMediaGroup(groupId) {
  if (!groupId) return false;
  if (processedMediaGroups.has(groupId)) return true;
  processedMediaGroups.add(groupId);
  setTimeout(() => processedMediaGroups.delete(groupId), 60000);
  return false;
}

function isDuplicateProduct(name, price) {
  if (!name) return false;
  const key = `${name.trim()}_${price}`;
  const now = Date.now();
  if (recentProductDebounce.has(key)) {
    const prevTime = recentProductDebounce.get(key);
    if (now - prevTime < 15000) { // 15 seconds debounce
      return true;
    }
  }
  recentProductDebounce.set(key, now);
  setTimeout(() => recentProductDebounce.delete(key), 60000);
  return false;
}

// ==========================================
// 1. TELEGRAM BOT ENGINE
// ==========================================

async function startTelegramBot(token) {
  if (!token) {
    telegramStatus = 'NOT_CONFIGURED';
    console.log('[Telegram] No Bot Token configured yet.');
    return;
  }

  try {
    telegramBot = new Bot(token);

    // Bot Error Catching to prevent polling drops
    telegramBot.catch((err) => {
      console.error('[Bot Engine Error]:', err.message);
    });

    // 0. Start & Help Commands
    telegramBot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 *ئەسسالامۇ ئەلەيكۇم! Noor Store سۈنئىي ئىدراك ۋە ئاپتوماتىك ماس قەدەملەش سىستېمىسىغا خۇش كەپسىز!*\n\n` +
        `🤖 *بۇ بوت نېمە ئىش قىلىدۇ؟*\n` +
        `ماڭا بىرەر مەھسۇلاتنىڭ رەسىمى ۋە باھاسىنى تاشلىسىڭىزلا، سۈنئىي ئەقىل ئارقىلىق ئاپتوماتىك تەھلىل قىلىپ:\n\n` +
        `1. 🌐 [Noor Store تور دۇكىنى](https://noor-store.yulgun353.workers.dev/) غا دەرھال قوشىدۇ\n` +
        `2. 📱 بارلىق يانفون ئەپلىرىگە يەتكۈزىدۇ\n` +
        `3. ✈️ [@NoorStore2](https://t.me/NoorStore2) تېلېگرام قانىلىغا يوللايدۇ\n` +
        `4. 💬 WhatsApp ئېلان گۇرۇپپىسىغا ماس قەدەمدە تارقىتىدۇ!\n\n` +
        `💡 *سىناپ بېقىش ئۈچۈن:* مەھسۇلات رەسىمى بىلەن باھاسىنى ئەۋەتىپ بېقىڭ!`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    });

    telegramBot.command('help', async (ctx) => {
      await ctx.reply(
        `📖 *ئىشلىتىش قوللانمىسى:*\n\n` +
        `تۆۋەندىكىدەك ھەرقانداق قېلىپتا ئۇچۇر ياكى رەسىم ئەۋەتسىڭىزلا بولىدۇ:\n\n` +
        `*iPhone 16 Pro Max (512GB)*\n` +
        `*باھاسى:* $1250\n` +
        `*ھالىتى:* پۈتۈنلەي يېڭى، كاپالەتلىك\n\n` +
        `سۈنئىي ئىدراك بارلىق پارامېتىرلارنى ئاپتوماتىك ئايرىيدۇ.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    });

    // Handle incoming messages (Channel Posts & Group / Private Messages)
    telegramBot.on(['channel_post', 'message'], async (ctx) => {
      try {
        const msg = ctx.channelPost || ctx.message;
        if (!msg) return;

        // Skip command messages (already handled)
        const rawText = msg.caption || msg.text || '';
        if (rawText.startsWith('/start') || rawText.startsWith('/help')) {
          return;
        }

        // 1. Ignore automatic forwards (e.g. from linked channel to discussion group)
        if (msg.is_automatic_forward) {
          console.log('[Telegram] ⏩ Skipping automatic forward from linked channel.');
          return;
        }

        // 2. Ignore messages sent by any bot or this bot itself
        if (msg.from?.is_bot || msg.sender_chat?.username === 'NoorStore2') {
          return;
        }

        // 3. Deduplicate media group / album items (process only first photo)
        if (msg.media_group_id && isDuplicateMediaGroup(msg.media_group_id)) {
          console.log(`[Telegram] ⏩ Skipping extra photo in media_group: ${msg.media_group_id}`);
          return;
        }

        // 4. Deduplicate message ID
        if (isDuplicateMessage(msg.chat?.id, msg.message_id)) {
          console.log(`[Telegram] ⏩ Skipping already processed message ID: ${msg.message_id}`);
          return;
        }

        const text = rawText;
        const photos = msg.photo;

        console.log(`\n[Telegram] 📥 Received message/post from chat ID ${msg.chat?.id} (${msg.chat?.type}): "${text.slice(0, 40)}..."`);

        // If no text or photo, skip
        if (!text && (!photos || photos.length === 0)) return;

        // Send instant typing action and "Analyzing..." feedback for private chats
        let processingMsg = null;
        if (msg.chat?.type === 'private') {
          ctx.api.sendChatAction(msg.chat.id, 'typing').catch(() => {});
          processingMsg = await ctx.reply('⏳ *سۈنئىي ئىدراك مەھسۇلات ئۇچۇرىنى تەھلىل قىلىپ، بارلىق سۇپىلارغا ماس قەدەملەۋاتىدۇ...*', {
            parse_mode: 'Markdown'
          }).catch(() => null);
        }

        // 5. Parse product details from text (Intelligent AI Assistant)
        const parsedProduct = await parseProductMessage(text);
        console.log('[Parser] Extracted details:', {
          name: parsedProduct.nameUg,
          price: parsedProduct.price,
          category: parsedProduct.categoryId,
          brand: parsedProduct.brand
        });

        // 6. Check product debounce (in case multiple triggers fire at once)
        if (isDuplicateProduct(parsedProduct.nameUg, parsedProduct.price)) {
          console.log(`[Telegram] ⚠️ Skipping rapid duplicate product: "${parsedProduct.nameUg}" $${parsedProduct.price}`);
          if (processingMsg) {
            ctx.api.deleteMessage(msg.chat.id, processingMsg.message_id).catch(() => {});
          }
          return;
        }

        // 7. Download highest quality photo if attached (single fast network call)
        let imageResName = '/images/img_phones_1786037591338.jpg';
        let photoBuffer = null;
        let highestPhotoId = null;

        if (photos && photos.length > 0) {
          const highestPhoto = photos[photos.length - 1];
          highestPhotoId = highestPhoto.file_id;
          try {
            const fileInfo = await ctx.api.getFile(highestPhotoId);
            if (fileInfo.file_path) {
              const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
              const photoResp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
              photoBuffer = Buffer.from(photoResp.data);
              imageResName = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
            }
          } catch (dlErr) {
            console.error('[Photo Download Error]:', dlErr.message);
          }
        }

        // 8. Prepare Direct Buttons & Clean Caption
        const directButtons = new InlineKeyboard()
          .url("🌐 تور دۇكىنى", CONFIG.STORE_URL || "https://noor-store.yulgun353.workers.dev/")
          .row()
          .url("✈️ تېلېگرام", "https://t.me/NoorStore2")
          .url("💬 ۋاتساپ", "https://chat.whatsapp.com/KFp89uoqOOfCj8ZLDXOlPy?s=sh&p=a&mlu=4");

        const currencySymbol = '$';

        const channelCaption = 
`✨ *${parsedProduct.nameUg}* ✨
━━━━━━━━━━━━━━━━━
💰 *باھاسى:* ${currencySymbol}${parsedProduct.price}
📝 *چۈشەندۈرۈش:*
${parsedProduct.descriptionUg || 'ئەلا سۈپەتلىك، كاپالەتلىك مەھسۇلات.'}
━━━━━━━━━━━━━━━━━
🌐 [تور دۇكىنى](https://noor-store.yulgun353.workers.dev/)
✈️ [تېلېگرام](https://t.me/NoorStore2) | 💬 [ۋاتساپ](https://chat.whatsapp.com/KFp89uoqOOfCj8ZLDXOlPy?s=sh&p=a&mlu=4)`;

        // 9. Execute Supabase insert, Telegram broadcast, and WhatsApp broadcast in PARALLEL for INSTANT speed!
        const dbPromise = insertProductToSupabase(parsedProduct, imageResName).catch(e => ({ success: false }));
        
        let tgChannelPromise = Promise.resolve();
        if (msg.chat.type === 'private') {
          const targetChannel = '@NoorStore2';
          if (highestPhotoId) {
            tgChannelPromise = ctx.api.sendPhoto(targetChannel, highestPhotoId, {
              caption: channelCaption,
              parse_mode: 'Markdown',
              reply_markup: directButtons
            }).catch(chanErr => console.log('[Telegram Channel Forward Notice]:', chanErr.message));
          } else {
            tgChannelPromise = ctx.api.sendMessage(targetChannel, channelCaption, {
              parse_mode: 'Markdown',
              reply_markup: directButtons
            }).catch(chanErr => console.log('[Telegram Channel Forward Notice]:', chanErr.message));
          }
        }

        const waPromise = sendProductToWhatsApp(parsedProduct, photoBuffer).catch(e => ({ success: false, groupName: 'خاتالىق' }));

        let adminReplyPromise = Promise.resolve();
        if (msg.chat.type === 'private') {
          // Delete temporary processing status message
          if (processingMsg) {
            ctx.api.deleteMessage(msg.chat.id, processingMsg.message_id).catch(() => {});
          }

          adminReplyPromise = ctx.reply(
            `✅ *مەھسۇلات سىستېمىغا ۋە بارلىق قاناللارغا مۇۋەپپەقىيەتلىك تارقىتىلدى!*\n\n` +
            `✨ *نامى:* ${parsedProduct.nameUg}\n` +
            `💰 *باھاسى:* ${currencySymbol}${parsedProduct.price}\n` +
            `📁 *تۈرى:* ${parsedProduct.categoryId}\n\n` +
            `🌐 [تور دۇكىنىدا كۆرۈش](https://noor-store.yulgun353.workers.dev/)\n` +
            `✈️ [تېلېگرامدا كۆرۈش](https://t.me/NoorStore2) | 💬 [ۋاتساپ](https://chat.whatsapp.com/KFp89uoqOOfCj8ZLDXOlPy?s=sh&p=a&mlu=4)`,
            { 
              parse_mode: 'Markdown',
              reply_markup: directButtons
            }
          ).catch(e => console.log('[Admin Reply Notice]:', e.message));
        }

        // Wait for all concurrent tasks simultaneously
        const [dbResult, _, waResult] = await Promise.all([dbPromise, tgChannelPromise, waPromise, adminReplyPromise]);

        const logEntry = {
          time: new Date().toLocaleTimeString(),
          name: parsedProduct.nameUg,
          price: parsedProduct.price,
          category: parsedProduct.categoryId,
          supabaseSuccess: dbResult?.success ?? true,
          whatsappSuccess: waResult?.success ?? false,
          whatsappGroup: waResult?.groupName || 'WhatsApp'
        };
        syncedLogs.unshift(logEntry);
        if (syncedLogs.length > 30) syncedLogs.pop();

      } catch (err) {
        console.error('[Telegram Handler Error]:', err.message);
      }
    });

    await telegramBot.start({
      onStart: (botInfo) => {
        telegramStatus = 'CONNECTED';
        console.log(`[Telegram] ✅ Bot started successfully as @${botInfo.username}!`);
      }
    });

  } catch (err) {
    telegramStatus = 'ERROR';
    console.error('[Telegram] Failed to start bot:', err.message);
  }
}

// ==========================================
// 2. SUPABASE CLOUD STATE & COMMAND SYNC LOOP
// ==========================================

async function syncWithCloudState() {
  const stateObj = {
    telegramStatus,
    whatsappStatus,
    latestQrDataUrl,
    selectedGroup: selectedGroup || (availableGroups.length > 0 ? availableGroups[0] : null),
    groupsCount: availableGroups.length,
    groups: availableGroups,
    logs: syncedLogs,
    geminiConfigured: !!CONFIG.GEMINI_API_KEY,
    geminiKey: CONFIG.GEMINI_API_KEY ? `${CONFIG.GEMINI_API_KEY.substring(0, 6)}...` : '',
    storeUrl: CONFIG.STORE_URL || 'https://noor-store.yulgun353.workers.dev/'
  };

  // Push latest status to Supabase
  await pushCloudSyncState(stateObj);

  // Check for commands from Website/App Admin panel
  const cmd = await fetchCloudCommands();
  if (cmd) {
    console.log('[Cloud Command Received]:', cmd);
    if (cmd.command === 'SET_GROUP' && cmd.targetGroupId) {
      setSelectedGroup(cmd.targetGroupId);
    } else if (cmd.command === 'REFRESH_GROUPS') {
      await refreshWhatsAppGroups();
    } else if (cmd.command === 'RESET_WHATSAPP') {
      resetWhatsAppAuth();
    } else if (cmd.command === 'SET_AI_KEY' && cmd.geminiKey !== undefined) {
      CONFIG.GEMINI_API_KEY = (cmd.geminiKey || '').trim();
      const envContent = `TELEGRAM_BOT_TOKEN=${CONFIG.TELEGRAM_BOT_TOKEN}\nSUPABASE_URL=${CONFIG.SUPABASE_URL}\nSUPABASE_KEY=${CONFIG.SUPABASE_KEY}\nSTORE_URL=${CONFIG.STORE_URL}\nPORT=${CONFIG.PORT}\nGEMINI_API_KEY=${CONFIG.GEMINI_API_KEY}\n`;
      fs.writeFileSync('./.env', envContent, 'utf-8');
      console.log(`[AI Configuration] Updated Gemini API Key via Cloud Command: ${CONFIG.GEMINI_API_KEY ? 'CONFIGURED' : 'CLEARED'}`);
    } else if (cmd.command === 'TEST_WHATSAPP') {
      const testProd = {
        nameUg: '✨ نۇرلۇق دۇكىنى سىناق مەھسۇلاتى (iPhone 16 Pro Max)',
        price: 1199,
        descriptionUg: 'ئاپتوماتىك ماس قەدەملەش سىستېمىسى سىنىقى. بارلىق گۇرۇپپا ۋە تېلېگرام ئۇلىنىشى نورمال.'
      };
      const res = await sendProductToWhatsApp(testProd, null);
      console.log('[Test WhatsApp Cloud Command Result]:', res);
    }
  }
}

setInterval(syncWithCloudState, 3000);

// ==========================================
// 3. WEB CONTROL DASHBOARD & REST API
// ==========================================

app.get('/api/status', (req, res) => {
  res.json({
    telegramStatus,
    whatsappStatus,
    latestQrDataUrl,
    selectedGroup: selectedGroup || (availableGroups.length > 0 ? availableGroups[0] : null),
    groupsCount: availableGroups.length,
    groups: availableGroups,
    logs: syncedLogs,
    geminiConfigured: !!CONFIG.GEMINI_API_KEY,
    geminiKey: CONFIG.GEMINI_API_KEY ? `${CONFIG.GEMINI_API_KEY.substring(0, 6)}...` : '',
    storeUrl: CONFIG.STORE_URL || 'https://noor-store.yulgun353.workers.dev/'
  });
});

app.get('/api/products', (req, res) => {
  const prods = getLocalProducts();
  res.json({ success: true, data: prods });
});

app.post('/api/products', async (req, res) => {
  const prod = req.body;
  const result = await insertProductToSupabase(prod, prod.image_res_name || prod.imageUrl || '');
  res.json(result);
});

app.post('/api/select-group', (req, res) => {
  const { groupId } = req.body;
  if (groupId) {
    const grp = setSelectedGroup(groupId);
    syncWithCloudState();
    return res.json({ success: true, selectedGroup: grp });
  }
  res.json({ success: false, message: 'Invalid groupId' });
});

app.post('/api/refresh-groups', async (req, res) => {
  const list = await refreshWhatsAppGroups();
  syncWithCloudState();
  res.json({ success: true, groups: list });
});

app.post('/api/test-whatsapp', async (req, res) => {
  const prod = req.body.product || {
    nameUg: '✨ نۇرلۇق دۇكىنى سىناق مەھسۇلاتى (iPhone 16 Pro Max)',
    price: 1199,
    descriptionUg: 'ئاپتوماتىك ماس قەدەملەش سىستېمىسى سىنىقى. سىستېما 100% نورمال ئىشلەۋاتىدۇ!'
  };
  const result = await sendProductToWhatsApp(prod, null);
  res.json(result);
});

app.post('/reset-whatsapp', (req, res) => {
  resetWhatsAppAuth();
  res.redirect('/');
});

app.post('/api/save-ai', (req, res) => {
  const { geminiKey } = req.body;
  CONFIG.GEMINI_API_KEY = (geminiKey || '').trim();
  const envContent = `TELEGRAM_BOT_TOKEN=${CONFIG.TELEGRAM_BOT_TOKEN}\nSUPABASE_URL=${CONFIG.SUPABASE_URL}\nSUPABASE_KEY=${CONFIG.SUPABASE_KEY}\nSTORE_URL=${CONFIG.STORE_URL}\nPORT=${CONFIG.PORT}\nGEMINI_API_KEY=${CONFIG.GEMINI_API_KEY}\n`;
  fs.writeFileSync('./.env', envContent, 'utf-8');
  console.log(`[AI Configuration] Updated Gemini API Key: ${CONFIG.GEMINI_API_KEY ? 'CONFIGURED' : 'CLEARED'}`);
  syncWithCloudState();
  res.json({ success: true, geminiConfigured: !!CONFIG.GEMINI_API_KEY });
});

app.post('/save-ai', async (req, res) => {
  const { geminiKey } = req.body;
  CONFIG.GEMINI_API_KEY = (geminiKey || '').trim();
  const envContent = `TELEGRAM_BOT_TOKEN=${CONFIG.TELEGRAM_BOT_TOKEN}\nSUPABASE_URL=${CONFIG.SUPABASE_URL}\nSUPABASE_KEY=${CONFIG.SUPABASE_KEY}\nSTORE_URL=${CONFIG.STORE_URL}\nPORT=${CONFIG.PORT}\nGEMINI_API_KEY=${CONFIG.GEMINI_API_KEY}\n`;
  fs.writeFileSync('./.env', envContent, 'utf-8');
  console.log(`[AI Configuration] Updated Gemini API Key: ${CONFIG.GEMINI_API_KEY ? 'CONFIGURED' : 'CLEARED'}`);
  res.redirect('/');
});

app.post('/save-telegram', async (req, res) => {
  const { botToken } = req.body;
  if (botToken) {
    CONFIG.TELEGRAM_BOT_TOKEN = botToken.trim();
    const envContent = `TELEGRAM_BOT_TOKEN=${CONFIG.TELEGRAM_BOT_TOKEN}\nSUPABASE_URL=${CONFIG.SUPABASE_URL}\nSUPABASE_KEY=${CONFIG.SUPABASE_KEY}\nSTORE_URL=${CONFIG.STORE_URL}\nPORT=${CONFIG.PORT}\nGEMINI_API_KEY=${CONFIG.GEMINI_API_KEY}\n`;
    fs.writeFileSync('./.env', envContent, 'utf-8');
    startTelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);
  }
  res.redirect('/');
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ug" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>Noor Store - كۆپ سۇپىلىق ئاپتوماتىك ماس قەدەملەش مەركىزى</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Alibaba+PuHuiTi&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Alibaba PuHuiTi', system-ui, sans-serif; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 sm:p-8">
  <div class="max-w-5xl mx-auto space-y-6">
    
    <!-- Header -->
    <div class="bg-slate-900/80 border border-slate-800 rounded-3xl p-6 shadow-2xl backdrop-blur flex flex-col sm:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-500 to-amber-400 flex items-center justify-center text-2xl shadow-lg shadow-emerald-500/20">
          ⚡
        </div>
        <div>
          <h1 class="text-xl font-bold text-emerald-400">Noor Store - ئاپتوماتىك ماس قەدەملەش سىستېمىسى</h1>
          <p class="text-xs text-slate-400">Telegram ➡️ Supabase (تور بېكەت + ئەپ) ➡️ WhatsApp</p>
        </div>
      </div>
      <a href="${CONFIG.STORE_URL}" target="_blank" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold transition-all shadow-md">
        🌐 تور دۇكىنىنى كۆرۈش
      </a>
    </div>

    <!-- Status Cards Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      
      <!-- Telegram Status -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold flex items-center gap-2">
            <span>✈️</span> Telegram Bot
          </span>
          <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
            telegramStatus === 'CONNECTED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
            telegramStatus === 'ERROR' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' :
            'bg-amber-500/20 text-amber-400 border border-amber-500/30'
          }">
            ${telegramStatus === 'CONNECTED' ? '✅ ئۇلاندى' : telegramStatus === 'ERROR' ? '❌ خاتالىق' : '⚠️ كىرگۈزۈلمىگەن'}
          </span>
        </div>
        <p class="text-xs text-slate-300 font-bold">بوت: @NoorStore520_Bot</p>
        <p class="text-[11px] text-slate-400">قانىتىش قانىلى: @NoorStore2 (Admin ID: 7251543464)</p>
        <form action="/save-telegram" method="POST" class="space-y-2 text-xs">
          <input 
            type="text" 
            name="botToken" 
            value="${CONFIG.TELEGRAM_BOT_TOKEN}" 
            placeholder="Bot Token (مەسىلەن: 789123:AAH...)" 
            class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 focus:outline-none focus:border-emerald-500 text-xs"
          />
          <button type="submit" class="w-full py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold transition-colors text-xs">
            ساقلاش ۋە ئۇلاش
          </button>
        </form>
      </div>

      <!-- Supabase Status -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold flex items-center gap-2">
            <span>☁️</span> Supabase Cloud
          </span>
          <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            ✅ ئاكتىپ
          </span>
        </div>
        <p class="text-xs text-slate-400 leading-relaxed">
          تور بېكەت ۋە ئاندىروئىد دېتالى بىلەن دەل ۋاقتىدا ئۇلانغان.
        </p>
      </div>

      <!-- AI Assistant Status -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold flex items-center gap-2">
            <span>🤖</span> سۈنئىي ئەقىل (AI)
          </span>
          <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
            CONFIG.GEMINI_API_KEY ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
            'bg-sky-500/20 text-sky-400 border border-sky-500/30'
          }">
            ${CONFIG.GEMINI_API_KEY ? '✨ Gemini AI ئاكتىپ' : '🧠 ئىچكى ئەقلىي ماتور'}
          </span>
        </div>
        <p class="text-[11px] text-slate-400 leading-relaxed">
          تېلېگرام ۋە باشقا يەرلەرگە يوللانغان ئۇچۇرلارنى ئاپتوماتىك ئوقۇپ، باھا، مودېل ۋە چۈشەندۈرۈشنى رەتلەيدۇ.
        </p>
        <form action="/save-ai" method="POST" class="space-y-2 text-xs">
          <input 
            type="password" 
            name="geminiKey" 
            value="${CONFIG.GEMINI_API_KEY}" 
            placeholder="Gemini API Key (ئىختىيارىي)" 
            class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 focus:outline-none focus:border-emerald-500 text-xs"
          />
          <button type="submit" class="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-colors text-xs">
            AI نى ساقلاش ۋە قوزغىتىش
          </button>
        </form>
      </div>

      <!-- WhatsApp Status -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-bold flex items-center gap-2">
            <span>💬</span> WhatsApp
          </span>
          <span id="wa-badge" class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
            whatsappStatus === 'CONNECTED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
            whatsappStatus === 'SCAN_QR' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse' :
            'bg-slate-800 text-slate-400'
          }">
            ${whatsappStatus === 'CONNECTED' ? '✅ ئۇلاندى' : whatsappStatus === 'SCAN_QR' ? '📷 QR كود كۈتۈلمەكتە' : '⚠️ ئۇلانمىدى'}
          </span>
        </div>
        
        <div id="wa-qr-container" class="flex flex-col items-center gap-2">
          ${latestQrDataUrl ? `
            <div class="flex flex-col items-center gap-2 p-3 bg-white rounded-2xl shadow-lg">
              <img src="${latestQrDataUrl}" alt="WhatsApp QR Code" class="w-40 h-40 object-contain" />
              <p class="text-[11px] text-slate-900 font-black text-center">📱 تېلېفوندىن سىكاننېرلاڭ</p>
            </div>
          ` : `
            <p class="text-xs text-slate-400 leading-relaxed text-center py-2">
              ${whatsappStatus === 'CONNECTED' ? `✅ WhatsApp تولۇق ئۇلاندى! (${availableGroups.length} گۇرۇپپا)` : 'QR كود ھازىرلىنىۋاتىدۇ...'}
            </p>
          `}
        </div>

        <!-- Target Group Dropdown -->
        <div id="wa-group-selector" class="space-y-1.5 text-xs">
          <div class="flex items-center justify-between">
            <label class="text-[11px] text-slate-400 font-bold">🎯 نىشانلىق WhatsApp گۇرۇپپىسى:</label>
            <button onclick="refreshGroupsList()" class="text-[10px] text-sky-400 hover:underline">🔄 يېڭىلاش</button>
          </div>
          <select id="group-select" onchange="changeGroup(this.value)" class="w-full px-2.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-emerald-400 font-semibold focus:outline-none focus:border-emerald-500">
            ${availableGroups.length > 0 ? 
              availableGroups.map(g => `<option value="${g.id}" ${selectedGroup?.id === g.id ? 'selected' : ''}>${g.subject}</option>`).join('') :
              '<option value="">گۇرۇپپا تېپىلمىدى</option>'
            }
          </select>
        </div>

        <form action="/reset-whatsapp" method="POST">
          <button type="submit" class="w-full py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold transition-colors">
            🔄 QR كودنى يېڭىلاش / قايتا ئۇلاش
          </button>
        </form>
      </div>

    </div>

    <!-- Live Sync Logs -->
    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4">
      <h2 class="text-sm font-bold flex items-center gap-2 text-slate-300">
        <span>📋</span> ئەڭ يېڭى ماس قەدەملەنگەن مەھسۇلاتلار خاتىرىسى (${syncedLogs.length})
      </h2>

      ${syncedLogs.length === 0 ? `
        <p class="text-xs text-slate-500 py-4 text-center">تېخى مەھسۇلات يوللانمىدى. تېلېگرام بوتىڭىزغا مەھسۇلات رەسىمى ۋە باھاسىنى تاشلاپ سىناپ بېقىڭ!</p>
      ` : `
        <div class="space-y-2">
          ${syncedLogs.map(l => `
            <div class="flex items-center justify-between p-3 rounded-2xl bg-slate-950 border border-slate-800/80 text-xs">
              <div class="flex items-center gap-3">
                <span class="text-slate-500 text-[10px]">${l.time}</span>
                <span class="font-bold text-slate-200">${l.name}</span>
                <span class="text-emerald-400 font-bold">$${l.price}</span>
              </div>
              <div class="flex items-center gap-2 text-[10px]">
                <span class="${l.supabaseSuccess ? 'text-emerald-400' : 'text-rose-400'}">☁️ Supabase ${l.supabaseSuccess ? 'OK' : 'FAIL'}</span>
                <span class="${l.whatsappSuccess ? 'text-emerald-400' : 'text-amber-400'}">💬 «${l.whatsappGroup || 'WhatsApp'}»</span>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <!-- Quick Usage Guide -->
    <div class="bg-emerald-950/30 border border-emerald-800/40 rounded-3xl p-5 space-y-2 text-xs text-emerald-200">
      <h3 class="font-bold text-emerald-400">💡 تېلېگرامدىن قانداق يوللايسىز؟</h3>
      <p>تېلېگرام قانال ياكى گۇرۇپپىڭىزغا رەسىم بىلەن تۆۋەندىكىدەك ھەرقانداق قېلىپتا يازسىڭىزلا سىستېما تولۇق چۈشىنىدۇ:</p>
      <div class="p-3 bg-slate-950/80 rounded-xl text-slate-300 font-mono text-[11px] leading-relaxed">
        iPhone 16 Pro Max (512GB)<br>
        باھاسى: 8999 يۈەن<br>
        رەڭگى قارا، پۈتۈنلەي يېڭى، كاپالەتلىك مەھسۇلات.
      </div>
    </div>

    <script>
      async function changeGroup(groupId) {
        if (!groupId) return;
        await fetch('/api/select-group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId })
        });
      }

      async function refreshGroupsList() {
        const res = await fetch('/api/refresh-groups', { method: 'POST' });
        const data = await res.json();
        if (data.groups) {
          const select = document.getElementById('group-select');
          select.innerHTML = data.groups.map(g => '<option value="' + g.id + '">' + g.subject + '</option>').join('');
        }
      }

      setInterval(async () => {
        try {
          const res = await fetch('/api/status');
          const data = await res.json();
          
          const badge = document.getElementById('wa-badge');
          const qrBox = document.getElementById('wa-qr-container');

          if (data.whatsappStatus === 'CONNECTED') {
            badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
            badge.innerText = '✅ ئۇلاندى';
            if (data.selectedGroup) {
              qrBox.innerHTML = '<div class="p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold text-center">🎯 نىشان گۇرۇپپا: ' + data.selectedGroup.subject + '</div>';
            }
          } else if (data.latestQrDataUrl) {
            badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse';
            badge.innerText = '📷 QR كود كۈتۈلمەكتە';
            qrBox.innerHTML = '<div class="flex flex-col items-center gap-2 p-3 bg-white rounded-2xl shadow-lg"><img src="' + data.latestQrDataUrl + '" class="w-40 h-40 object-contain" /><p class="text-[11px] text-slate-900 font-black text-center">📱 تېلېفوندىن سىكاننېرلاڭ</p></div>';
          }
        } catch(e) {}
      }, 2000);
    </script>

  </div>
</body>
</html>
  `);
});

// ==========================================
// 4. START SERVICES
// ==========================================

// Health check endpoint for cloud platforms
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

const PORT = CONFIG.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Noor Store Auto Sync Engine Running on port ${PORT}`);
  console.log(`🌐 Web Management Dashboard: http://localhost:${PORT}`);
  console.log(`☁️  Cloud Mode: ${process.env.RENDER ? 'Render.com' : process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'Local'}`);
  console.log(`======================================================\n`);

  // 1. Restore WhatsApp auth from Supabase cloud backup (for ephemeral filesystems)
  try {
    await restoreAuthFromCloud();
  } catch (e) {
    console.log('[Boot] Auth restore notice:', e.message);
  }

  // 2. Start WhatsApp client
  initWhatsAppClient();

  // 3. Start Telegram bot
  if (CONFIG.TELEGRAM_BOT_TOKEN) {
    startTelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);
  } else {
    console.log('[Telegram] No token yet. Visit the dashboard to enter your Telegram Bot Token!');
  }

  // 4. Self-ping keep-alive for cloud free-tier (prevents sleep after 15min inactivity)
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  
  if (SELF_URL || process.env.RENDER) {
    const pingUrl = SELF_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}/health`;
    setInterval(async () => {
      try {
        await fetch(pingUrl, { signal: AbortSignal.timeout(5000) });
        console.log(`[KeepAlive] 🏓 Self-ping OK at ${new Date().toISOString()}`);
      } catch (e) {
        // ignore ping failures
      }
    }, 10 * 60 * 1000); // every 10 minutes
    console.log(`[KeepAlive] ⏰ Self-ping enabled every 10 minutes: ${pingUrl}`);
  }
});
