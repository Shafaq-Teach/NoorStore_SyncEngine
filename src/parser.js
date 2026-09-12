import axios from 'axios';
import { CONFIG } from './config.js';

/**
 * Intelligent AI Assistant & Smart Parser for Product Announcements
 * Combines Google Gemini AI with an ultra-accurate Uyghur/Arabic NLP engine.
 * Distinguishes strictly between Storage/RAM/Battery numbers and actual Price!
 */

export const parseProductMessage = parseProductWithAI;

export async function parseProductWithAI(text = '') {
  const cleanText = normalizeNumbers(text).trim();
  if (!cleanText) {
    return parseProductRuleBased('');
  }

  // 1. If Gemini API key is configured, use Gemini AI for smart analysis
  if (CONFIG.GEMINI_API_KEY) {
    try {
      const prompt = `You are an expert e-commerce catalog assistant specialized in Uyghur, Arabic, and English product announcements.
Analyze the following product advertisement and return a STRICT JSON object (no markdown code blocks, just raw JSON) with the following fields:
{
  "nameUg": "Precise product name/title in Uyghur (e.g. iPhone 16 Pro Max or S23 Ultra)",
  "nameAr": "Product name in Arabic",
  "nameEn": "Product name in English",
  "price": (number only, the actual selling price in numbers, e.g. 485),
  "originalPrice": (number, 10% higher than price or original price mentioned),
  "categoryId": "one of: phones, tablets, watches, accessories, laptops, gaming",
  "brand": "one of: Apple, Samsung, Xiaomi, Huawei, Anker, Sony, Other",
  "cleanDescriptionUg": "Clean, well-structured, beautiful Uyghur description highlighting key points (battery, condition, storage, warranty, etc.) without repetitive junk text",
  "specsUg": "Short technical specs string (e.g. سىغىمى: 512GB | رام: 12GB | باتارېيە: 5000mAh)"
}

IMPORTANT RULES:
- CRITICAL: Phone storage numbers (e.g. 64, 128, 256, 512, 1024, 1TB, ساقلىغۇچ 512, سىغىمى 256GB), RAM (e.g. 8, 12, 16, 24), Battery (e.g. 4500, 5000), Camera (e.g. 50, 108, 200MP) are TECHNICAL SPECS and MUST NEVER be used as the price!
- Price is ONLY the currency selling amount specified after words like باھاسى, باھا, سعر, السعر, $, 💵, دوللار.

Input Text:
"""
${cleanText}
"""`;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        },
        { timeout: 3500 }
      );

      const jsonStr = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        if (parsed && (parsed.nameUg || parsed.price)) {
          return {
            nameUg: (parsed.nameUg || 'يېڭى مەھسۇلات').toWellFormed ? (parsed.nameUg || 'يېڭى مەھسۇلات').toWellFormed() : (parsed.nameUg || 'يېڭى مەھسۇلات'),
            nameAr: parsed.nameAr || parsed.nameUg,
            nameEn: parsed.nameEn || parsed.nameUg,
            price: Number(parsed.price) || 0,
            originalPrice: Number(parsed.originalPrice) || (Number(parsed.price || 0) * 1.1),
            categoryId: parsed.categoryId || 'phones',
            brand: parsed.brand || 'Apple',
            descriptionUg: (parsed.cleanDescriptionUg || cleanText).toWellFormed ? (parsed.cleanDescriptionUg || cleanText).toWellFormed() : (parsed.cleanDescriptionUg || cleanText),
            descriptionAr: parsed.cleanDescriptionUg || cleanText,
            descriptionEn: parsed.cleanDescriptionUg || cleanText,
            specsUg: parsed.specsUg || `Marka: ${parsed.brand || 'Apple'}`,
            specsAr: parsed.specsUg || '',
            specsEn: parsed.specsUg || '',
            isFeatured: true,
            inStock: true
          };
        }
      }
    } catch (aiErr) {
      console.log('[AI Assistant Note]: Falling back to smart built-in engine:', aiErr.message);
    }
  }

  // 2. Built-in Smart Rule Engine (Fast, zero-latency, highly accurate for Uyghur e-commerce)
  return parseProductRuleBased(cleanText);
}

export function normalizeNumbers(str) {
  if (!str) return '';
  const map = {
    '0️⃣': '0', '1️⃣': '1', '2️⃣': '2', '3️⃣': '3', '4️⃣': '4',
    '5️⃣': '5', '6️⃣': '6', '7️⃣': '7', '8️⃣': '8', '9️⃣': '9',
    '0⃣': '0', '1⃣': '1', '2⃣': '2', '3⃣': '3', '4⃣': '4',
    '5⃣': '5', '6⃣': '6', '7⃣': '7', '8⃣': '8', '9⃣': '9',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
  };
  let res = str;
  for (const [k, v] of Object.entries(map)) {
    res = res.replaceAll(k, v);
  }
  return res;
}

export function parseProductRuleBased(text = '') {
  const cleanText = text ? text.trim() : '';
  const normalizedText = normalizeNumbers(cleanText).trim();
  if (!normalizedText) {
    return {
      nameUg: 'يېڭى مەھسۇلات',
      nameAr: 'منتج جديد',
      nameEn: 'New Product',
      price: 0,
      originalPrice: 0,
      categoryId: 'phones',
      brand: 'Noor',
      descriptionUg: '',
      specsUg: ''
    };
  }

  const lines = normalizedText.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. EXTRACT PRICE (STRICT PATTERNS EXCLUDING STORAGE / RAM)
  let price = 0;

  // First priority: Explicit price indicators
  const explicitPricePatterns = [
    /(?:باھاسى|باھا|باھاسىنى|باھاسى\s*:|نەرقى|السعر|سعر|Price|price|ئارانلا|نەق)\s*[:：\-]?\s*[^\d\n]*?(\d+(?:\.\d+)?)/i,
    /(?:💵|💰|\$|USD|دوللار|TL|ليرة)\s*[:：\-]?\s*(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*(?:يۈەن|تۈمەن|سوم|TL|USD|\$|ريال|درهم|lira|tl|دوللار|dollar|💵|💰)/i
  ];

  for (const regex of explicitPricePatterns) {
    const match = normalizedText.match(regex);
    if (match && match[1]) {
      let rawNum = match[1];
      if (rawNum.startsWith('0') && rawNum.length >= 2) {
        rawNum = rawNum.split('').reverse().join('');
      }
      const num = parseFloat(rawNum);
      if (!isNaN(num) && num > 0) {
        price = num;
        break;
      }
    }
  }

  // If price is not found, search lines carefully (filtering out Storage, RAM, Battery, Camera)
  if (price === 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Ignore lines describing storage, ram, battery, camera, model
      if (/(?:ساقلغۇچ|ساقلىغۇچ|سىغىم|سىغىمى|رام|باتارېيە|كامېرا|ئاندرويىد|android|mah|gb|tb|mp|giga|ram|rom)/i.test(line)) {
        continue;
      }
      const matches = line.match(/\b([0-9]{1,5})\b/g);
      if (matches && matches.length > 0) {
        let rawNum = matches[matches.length - 1];
        if (rawNum.startsWith('0') && rawNum.length >= 2) {
          rawNum = rawNum.split('').reverse().join('');
        }
        const val = parseFloat(rawNum);
        if (val !== 64 && val !== 128 && val !== 256 && val !== 512 && val !== 1024) {
          price = val;
          break;
        }
      }
    }
  }

  // 2. EXTRACT BRAND
  let brand = 'Apple';
  const brandKeywords = [
    { name: 'Apple', pattern: /(?:iPhone|iPad|MacBook|Apple|ئالما|آبل|AirPods|iWatch)/i },
    { name: 'Samsung', pattern: /(?:Samsung|Galaxy|سامسۇڭ|سامسونج|Ultra|S24|S25|S23|S22|Z Fold)/i },
    { name: 'Xiaomi', pattern: /(?:Xiaomi|Redmi|شاۋمى|شاومي|POCO|Pad 6|Pad 7|Note)/i },
    { name: 'Huawei', pattern: /(?:Huawei|خۇاۋېي|هواوي|Mate|Pura)/i },
    { name: 'Anker', pattern: /(?:Anker|ئانكېر|أنكر|باستىلىق|Charger)/i },
    { name: 'Sony', pattern: /(?:Sony|سونى|سوني|PlayStation)/i }
  ];

  for (const b of brandKeywords) {
    if (b.pattern.test(cleanText)) {
      brand = b.name;
      break;
    }
  }

  // 3. EXTRACT CATEGORY
  let categoryId = 'phones';
  if (/(?:iPad|Tablet|تەبلىت|تابلت|Pad|لوحي)/i.test(cleanText)) {
    categoryId = 'ipads';
  } else if (/(?:Watch|سائەت|ساعة|Ultra 2|Band)/i.test(cleanText)) {
    categoryId = 'watches';
  } else if (/(?:MacBook|Laptop|كومپيۇتېر|حاسوب|نوت بوك)/i.test(cleanText)) {
    categoryId = 'laptops';
  } else if (/(?:AirPods|Headphone|قۇلاقلىق|سماعة|Charger|تېزلەتكۈچ|كابېل|Powerbank)/i.test(cleanText)) {
    categoryId = 'accessories';
  } else if (/(?:PlayStation|PS5|PS4|ئويۇن|Gaming|Xbox)/i.test(cleanText)) {
    categoryId = 'gaming';
  }

  // 4. EXTRACT TITLE
  let nameUg = lines[0].replace(/^[\s\*\#\-\•\—\⚡\📱\✨\🔥]+/, '').trim();
  if (!nameUg || nameUg.length < 3) {
    nameUg = `${brand} يېڭى مەھسۇلات`;
  }

  return {
    nameUg,
    nameAr: nameUg,
    nameEn: nameUg,
    price,
    originalPrice: price > 0 ? Math.round(price * 1.1) : 0,
    categoryId,
    brand,
    descriptionUg: cleanText,
    descriptionAr: cleanText,
    descriptionEn: cleanText,
    specsUg: `Marka: ${brand} | Turi: ${categoryId}`,
    isFeatured: true,
    inStock: true
  };
}
