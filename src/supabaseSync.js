import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';
import axios from 'axios';
import fs from 'fs';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

/**
 * Downloads a Telegram file from bot API as base64 Data URL
 */
export async function downloadTelegramPhotoAsDataUrl(botToken, filePath) {
  try {
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch (err) {
    console.error('Error downloading Telegram photo:', err.message);
    return '/images/img_phones_1786037591338.jpg';
  }
}

const PRODUCTS_FILE = './products_db.json';

// Initialize default products if not exists
export function getLocalProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const content = fs.readFileSync(PRODUCTS_FILE, 'utf-8');
      return JSON.parse(content) || [];
    }
  } catch (e) {}
  return [];
}

export function saveLocalProducts(products) {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Storage] Error saving local products:', e.message);
  }
}

/**
 * Inserts the parsed product into Supabase Database and Local Persistent DB
 */
export async function insertProductToSupabase(productData, imageUrl = '') {
  try {
    const existing = getLocalProducts();
    const maxId = existing.length > 0 
      ? Math.max(...existing.map(p => Number(p.id) || 0)) 
      : 100;
    const newId = (maxId > 0 ? maxId : 100) + 1;

    const row = {
      id: newId,
      name_ug: productData.nameUg || 'Noor Product',
      name_ar: productData.nameAr || productData.nameUg || 'Noor Product',
      name_en: productData.nameEn || productData.nameUg || 'Noor Product',
      description_ug: productData.descriptionUg || '',
      description_ar: productData.descriptionAr || '',
      description_en: productData.descriptionEn || '',
      price: Number(productData.price) || 0,
      original_price: productData.originalPrice ? Number(productData.originalPrice) : (Number(productData.price || 0) * 1.1),
      category_id: productData.categoryId || 'phones',
      brand: productData.brand || 'Apple',
      image_res_name: imageUrl || '/images/img_phones_1786037591338.jpg',
      image_res_name2: '',
      image_res_name3: '',
      is_featured: !!productData.isFeatured,
      in_stock: productData.inStock !== false,
      specs_ug: productData.specsUg || `Marka: ${productData.brand || 'Noor'}`,
      specs_ar: productData.specsAr || '',
      specs_en: productData.specsEn || '',
      likes_count: 0,
      hearts_count: 0
    };

    // 1. Save to local persistent database immediately
    existing.unshift(row);
    saveLocalProducts(existing);
    console.log(`[SyncEngine] 💾 Saved product #${newId} to local persistent database: "${row.name_ug}" ($${row.price})`);

    // 2. Try Supabase cloud insert in parallel
    try {
      await supabase.from('products').insert([row]);
    } catch (sbErr) {
      console.log('[Supabase Cloud Notice]:', sbErr.message);
    }

    return { success: true, product: row };
  } catch (err) {
    console.error('[SyncEngine] Exception:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Pushes live sync state to Supabase so ANY device can read it globally
 */
export async function pushCloudSyncState(stateObj) {
  try {
    const payload = JSON.stringify(stateObj);
    const row = {
      id: 999999,
      product_id: 1,
      user_name: '__SYNC_STATE__',
      comment: payload,
      rating: 5,
      timestamp: Date.now()
    };
    await supabase.from('reviews').upsert([row]);
  } catch (err) {
    // silent
  }
}

/**
 * Reads pending command (e.g. SET_GROUP, REFRESH_GROUPS) from Supabase
 */
export async function fetchCloudCommands() {
  try {
    const { data } = await supabase.from('reviews').select('admin_reply').eq('id', 999999).maybeSingle();
    if (data && data.admin_reply) {
      try {
        const cmd = JSON.parse(data.admin_reply);
        // Clear command after reading
        await supabase.from('reviews').update({ admin_reply: '' }).eq('id', 999999);
        return cmd;
      } catch (e) {
        return null;
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

