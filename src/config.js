import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Telegram Bot Token from @BotFather
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8741726555:AAFrsGEsYrDYDIzWjMZd4aQxMrz_paL3Sog',
  
  // Telegram Admin ID
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || '7251543464',

  // Optional: Listen only to specific channel/group ID (if empty, listens to all messages where bot is admin)
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || '',

  // Supabase Configuration
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://ufkblidmcscbgardibkm.supabase.co',
  SUPABASE_KEY: process.env.SUPABASE_KEY || 'sb_publishable_9LBjrGb7H2D4LKpN8s4gvQ_SknfuLEH',

  // Target WhatsApp Group Name (e.g. "Noor Store خېرىدارلار گۇرۇپپىسى")
  WHATSAPP_GROUP_NAME: process.env.WHATSAPP_GROUP_NAME || '',

  // Gemini AI Key (Optional for intelligent AI parsing)
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',

  // Web Dashboard Port
  PORT: process.env.PORT || 3000,

  // Online Store Public URL (Cloudflare Worker/Pages Domain)
  STORE_URL: process.env.STORE_URL || 'https://noor-store.yulgun353.workers.dev/'
};
