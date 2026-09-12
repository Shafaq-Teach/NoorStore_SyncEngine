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
  saveLocalProducts,
  supabase
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

    // Bot Error Catching
    telegramBot.catch((err) => {
      console.error('[Bot Engine Error]:', err.message);
    });

    // Telegram Bot operates via Cloudflare Worker 24/7 Webhook
    // Local daemon only handles WhatsApp socket and Supabase auto-sync
    telegramStatus = 'CONNECTED';
    console.log('[Telegram] ✅ Bot active 24/7 via Cloudflare Worker Webhook!');
  } catch (err) {
    telegramStatus = 'ERROR';
    console.error('[Telegram] Initialization notice:', err.message);
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
    } else if (cmd.command === 'BROADCAST_LATEST') {
      console.log('[Cloud Command] 🚀 Broadcasting latest product to WhatsApp with all images...');
      try {
        const { data } = await supabase.from('products').select('*').order('created_at', { ascending: false }).limit(1);
        if (data && data.length > 0) {
          const item = data[0];
          const photoBuffers = [];
          const imageUrls = [item.image_res_name, item.image_res_name2, item.image_res_name3].filter(Boolean);
          for (const imgUrl of imageUrls) {
            if (imgUrl && imgUrl.startsWith('http')) {
              try {
                const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 8000 });
                photoBuffers.push(Buffer.from(resp.data));
              } catch(e) {}
            }
          }
          const res = await sendProductToWhatsApp({
            nameUg: item.name_ug,
            price: item.price,
            descriptionUg: item.description_ug
          }, photoBuffers);
          console.log('[Cloud Command BROADCAST_LATEST Result]:', res);
        }
      } catch (err) {
        console.error('[Cloud Command BROADCAST_LATEST Error]:', err.message);
      }
    }
  }
}

const seenProductIds = new Set();
let isInitialSyncDone = false;

async function checkAndBroadcastNewSupabaseProducts() {
  try {
    const { data } = await supabase.from('products').select('*').order('created_at', { ascending: false }).limit(10);
    if (!data || data.length === 0) return;

    if (!isInitialSyncDone) {
      data.forEach(p => seenProductIds.add(String(p.id)));
      isInitialSyncDone = true;
      return;
    }

    for (const item of data) {
      const idStr = String(item.id);
      if (!seenProductIds.has(idStr)) {
        seenProductIds.add(idStr);
        console.log(`[SyncEngine] 📦 New product detected (${idStr}: "${item.name_ug}"). Waiting 4s for all album photos to settle in Supabase...`);
        await new Promise(r => setTimeout(r, 4000));

        // Re-fetch to ensure any late-settling sibling images (image_res_name2, image_res_name3) are included
        let currentItem = item;
        try {
          const { data: freshData } = await supabase.from('products').select('*').eq('id', item.id).single();
          if (freshData) currentItem = freshData;
        } catch (e) {}

        const photoBuffers = [];
        const imageUrls = [currentItem.image_res_name, currentItem.image_res_name2, currentItem.image_res_name3].filter(Boolean);
        for (const imgUrl of imageUrls) {
          if (imgUrl && imgUrl.startsWith('http')) {
            try {
              const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 8000 });
              photoBuffers.push(Buffer.from(resp.data));
            } catch(e) {}
          }
        }
        console.log(`[SyncEngine] 🚀 Broadcasting "${currentItem.name_ug}" with ${photoBuffers.length} photo(s) to WhatsApp...`);
        const res = await sendProductToWhatsApp({
          nameUg: currentItem.name_ug,
          price: currentItem.price,
          descriptionUg: currentItem.description_ug
        }, photoBuffers);

        if (res.success) {
          const now = new Date();
          const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          syncedLogs.unshift({
            time: timeStr,
            name: currentItem.name_ug,
            price: item.price,
            supabaseSuccess: true,
            whatsappSuccess: true,
            whatsappGroup: res.groupName || 'Noor_Store'
          });
          if (syncedLogs.length > 20) syncedLogs = syncedLogs.slice(0, 20);
          syncWithCloudState();
        }
      }
    }
  } catch (err) {
    // silent
  }
}

setInterval(syncWithCloudState, 3000);
setInterval(checkAndBroadcastNewSupabaseProducts, 3000);

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
