import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  prepareWAMessageMedia, 
  generateWAMessageFromContent 
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import { CONFIG } from './config.js';
import { backupAuthToCloud } from './authBackup.js';

export let whatsappSocket = null;
export let whatsappStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTED'
export let latestQrDataUrl = null;
export let availableGroups = [];

const logger = pino({ level: 'silent' });

const TARGET_GROUP_FILE = './target_group.json';

export let selectedGroup = null;

// Load previously saved group on boot
try {
  if (fs.existsSync(TARGET_GROUP_FILE)) {
    const data = JSON.parse(fs.readFileSync(TARGET_GROUP_FILE, 'utf-8'));
    if (data && data.id) {
      selectedGroup = data;
      CONFIG.WHATSAPP_TARGET_JID = data.id;
      CONFIG.WHATSAPP_GROUP_NAME = data.subject;
      console.log(`[WhatsApp] 💾 Loaded persistent saved group: "${data.subject}" (${data.id})`);
    }
  }
} catch (e) {
  // ignore
}

export function setSelectedGroup(groupId) {
  let grp = availableGroups.find(g => g.id === groupId);
  if (!grp && selectedGroup && selectedGroup.id === groupId) {
    grp = selectedGroup;
  }
  if (!grp) {
    grp = { id: groupId, subject: 'WhatsApp Group' };
  }

  selectedGroup = grp;
  CONFIG.WHATSAPP_TARGET_JID = grp.id;
  CONFIG.WHATSAPP_GROUP_NAME = grp.subject;

  try {
    fs.writeFileSync(TARGET_GROUP_FILE, JSON.stringify(grp, null, 2));
    console.log(`[WhatsApp] 🎯 Target group permanently saved to disk: "${grp.subject}" (${grp.id})`);
  } catch (e) {
    console.error('[WhatsApp] Failed to save target group file:', e.message);
  }
  return grp;
}

export function resetWhatsAppAuth() {
  try {
    if (whatsappSocket) {
      whatsappSocket.end(new Error('Reset Auth'));
    }
    const authDir = './auth_info_baileys';
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    whatsappStatus = 'DISCONNECTED';
    latestQrDataUrl = null;
    console.log('[WhatsApp] Cleared auth credentials. Ready for fresh scan.');
    setTimeout(initWhatsAppClient, 1000);
  } catch (e) {
    console.error('[WhatsApp] Reset Error:', e.message);
  }
}

export async function initWhatsAppClient() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    whatsappSocket = makeWASocket({
      auth: state,
      logger,
      browser: ['Noor Store Desktop', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => ({ conversation: '' })
    });

    whatsappSocket.ev.on('creds.update', async () => {
      await saveCreds();
      // Auto-backup to Supabase cloud on every creds change
      backupAuthToCloud().catch(() => {});
    });

    whatsappSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        whatsappStatus = 'SCAN_QR';
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
          console.log('\n[WhatsApp] 📷 New QR Code generated! Open http://localhost:3000 to scan with phone.\n');
        } catch (e) {
          // ignore
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        whatsappStatus = 'DISCONNECTED';
        console.log(`[WhatsApp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
        
        if (statusCode === DisconnectReason.loggedOut) {
          resetWhatsAppAuth();
        } else if (shouldReconnect) {
          setTimeout(initWhatsAppClient, 4000);
        }
      } else if (connection === 'open') {
        whatsappStatus = 'CONNECTED';
        latestQrDataUrl = null;
        console.log('[WhatsApp] ✅ Connected successfully to WhatsApp!');

        // Backup auth to Supabase cloud for persistence across restarts
        setTimeout(() => backupAuthToCloud().catch(() => {}), 5000);

        // Fetch groups list immediately and with auto-retry
        const fetchInitialGroups = async () => {
          try {
            const chats = await whatsappSocket.groupFetchAllParticipating();
            if (chats && typeof chats === 'object') {
              availableGroups = Object.values(chats).map(g => ({
                id: g.id,
                subject: g.subject || 'WhatsApp Group'
              }));
              console.log(`[WhatsApp] Loaded ${availableGroups.length} available WhatsApp groups.`);

              // Re-affirm selected group from disk or list
              if (selectedGroup && selectedGroup.id) {
                const found = availableGroups.find(g => g.id === selectedGroup.id);
                if (found) {
                  selectedGroup = found;
                }
              } else if (availableGroups.length > 0) {
                setSelectedGroup(availableGroups[0].id);
              }
            }
          } catch (err) {
            console.log('[WhatsApp] Group fetch initial notice:', err.message);
          }
        };

        fetchInitialGroups();
        setTimeout(fetchInitialGroups, 3000);
        setTimeout(fetchInitialGroups, 8000);
      }
    });

  } catch (err) {
    console.error('[WhatsApp] Init Error:', err.message);
  }
}

export async function refreshWhatsAppGroups() {
  if (!whatsappSocket || whatsappStatus !== 'CONNECTED') return availableGroups;
  try {
    const chats = await whatsappSocket.groupFetchAllParticipating();
    if (chats && typeof chats === 'object') {
      availableGroups = Object.values(chats).map(g => ({
        id: g.id,
        subject: g.subject || 'WhatsApp Group'
      }));
      console.log(`[WhatsApp] 🔄 Refreshed ${availableGroups.length} available WhatsApp groups.`);
      
      // Update selectedGroup if it matches
      if (selectedGroup && selectedGroup.id) {
        const found = availableGroups.find(g => g.id === selectedGroup.id);
        if (found) {
          selectedGroup = found;
        }
      } else if (availableGroups.length > 0 && !selectedGroup) {
        setSelectedGroup(availableGroups[0].id);
      }
    }
    return availableGroups;
  } catch (e) {
    console.error('[WhatsApp] Refresh error:', e.message);
    return availableGroups;
  }
}

/**
 * Broadcasts a product announcement to the configured WhatsApp group
 */
export async function sendProductToWhatsApp(productData, photoBuffers = []) {
  if (!whatsappSocket || whatsappStatus !== 'CONNECTED') {
    console.log('[WhatsApp] Not connected, skipping WhatsApp broadcast.');
    return { success: false, message: 'WhatsApp not connected', groupName: 'ئۇلانمىغان' };
  }

  try {
    // 1. Find target group: ALWAYS prioritize saved selectedGroup!
    let targetGroup = null;
    if (selectedGroup && selectedGroup.id) {
      targetGroup = selectedGroup;
    } else if (CONFIG.WHATSAPP_TARGET_JID) {
      targetGroup = availableGroups.find(g => g.id === CONFIG.WHATSAPP_TARGET_JID) || { id: CONFIG.WHATSAPP_TARGET_JID, subject: CONFIG.WHATSAPP_GROUP_NAME || 'WhatsApp Group' };
    } else if (CONFIG.WHATSAPP_GROUP_NAME) {
      targetGroup = availableGroups.find(g => 
        g.subject && g.subject.toLowerCase().includes(CONFIG.WHATSAPP_GROUP_NAME.toLowerCase())
      );
    }

    if (!targetGroup && availableGroups.length > 0) {
      targetGroup = availableGroups[0];
    }

    if (!targetGroup) {
      console.log('[WhatsApp] ⚠️ No participating WhatsApp group found.');
      return { success: false, message: 'No WhatsApp group found', groupName: 'تېپىلمىدى' };
    }

    const targetJid = targetGroup.id;
    const groupName = targetGroup.subject || 'WhatsApp Group';
    const currencySymbol = '$';
    const caption = 
`✨ *${productData.nameUg || 'يېڭى مەھسۇلات'}* ✨
━━━━━━━━━━━━━━━━━
💰 *باھاسى:* ${currencySymbol}${productData.price}
📝 *چۈشەندۈرۈش:*
${productData.descriptionUg || 'ئەلا سۈپەتلىك، كاپالەتلىك مەھسۇلات.'}
━━━━━━━━━━━━━━━━━
🌐 *تور دۇكىنى:*
https://noor-store.yulgun353.workers.dev/

✈️ *تېلېگرام قانىلى:*
https://t.me/NoorStore2

💬 *ۋاتساپ گۇرۇپپىسى:*
https://chat.whatsapp.com/KFp89uoqOOfCj8ZLDXOlPy?s=sh&p=a&mlu=4`;

    const buffers = Array.isArray(photoBuffers) ? photoBuffers : (photoBuffers ? [photoBuffers] : []);

    if (buffers.length > 1) {
      // Multi-photo Album:
      // Pre-upload all photos in parallel and relay stanzas with 0 delay so WhatsApp
      // groups them into an album collage side-by-side with text underneath.
      try {
        const mediaUploads = await Promise.all(
          buffers.map(buf => prepareWAMessageMedia({ image: buf }, { upload: whatsappSocket.waUploadToServer }))
        );

        for (let i = 0; i < mediaUploads.length; i++) {
          const content = mediaUploads[i];
          if (i === 0) {
            content.imageMessage.caption = caption;
          }
          const msg = generateWAMessageFromContent(targetJid, content, {
            userJid: whatsappSocket.user?.id
          });
          await whatsappSocket.relayMessage(targetJid, msg.message, {
            messageId: msg.key.id
          });
        }
      } catch (albumErr) {
        console.warn('[WhatsApp] Pre-upload album fallback:', albumErr.message);
        // Fallback: send sequentially with 0 delay
        for (let i = 0; i < buffers.length; i++) {
          await whatsappSocket.sendMessage(targetJid, {
            image: buffers[i],
            ...(i === 0 ? { caption } : {})
          });
        }
      }
    } else if (buffers.length === 1) {
      await whatsappSocket.sendMessage(targetJid, {
        image: buffers[0],
        caption
      });
    } else {
      await whatsappSocket.sendMessage(targetJid, {
        text: caption
      });
    }

    console.log(`[WhatsApp] ✅ Broadcasted ${buffers.length} photos to WhatsApp group: "${groupName}" (${targetJid})!`);
    return { success: true, groupName, groupId: targetJid };
  } catch (err) {
    console.error('[WhatsApp] Broadcast error:', err.message);
    return { success: false, error: err.message, groupName: 'خاتالىق' };
  }
}
