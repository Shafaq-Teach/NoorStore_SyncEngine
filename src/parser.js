import axios from 'axios';
import { CONFIG } from './config.js';

/**
 * Intelligent AI Assistant & Smart Parser for Product Announcements
 * Combines Google Gemini AI (when API key is set) with an ultra-accurate Uyghur/Arabic NLP engine.
 */

export async function parseProductWithAI(text = '') {
  const cleanText = text.trim();
  if (!cleanText) {
    return parseProductRuleBased('');
  }

  // 1. If Gemini API key is configured, use Gemini AI for smart analysis
  if (CONFIG.GEMINI_API_KEY) {
    try {
      const prompt = `You are an expert e-commerce catalog assistant specialized in Uyghur, Arabic, and English product announcements.
Analyze the following product advertisement and return a STRICT JSON object (no markdown code blocks, just raw JSON) with the following fields:
{
  "nameUg": "Precise product name/title in Uyghur (e.g. ئالما 16 or iPhone 16 Pro Max)",
  "nameAr": "Product name in Arabic",
  "nameEn": "Product name in English",
  "price": (number only, the actual selling price in numbers, e.g. 575),
  "originalPrice": (number, 10% higher than price or original price mentioned),
  "categoryId": "one of: phones, tablets, watches, accessories, laptops, gaming",
  "brand": "one of: Apple, Samsung, Xiaomi, Huawei, Anker, Sony, Other",
  "cleanDescriptionUg": "Clean, well-structured, beautiful Uyghur description highlighting key points (battery, condition, storage, warranty, etc.) without repetitive junk text",
  "specsUg": "Short technical specs string (e.g. سىغىمى: 128GB | باتارېيە: 91% | ھالىتى: يېڭىدەك)"
}

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

export function parseProductRuleBased(text = '') {
  const cleanText = text.trim();
  if (!cleanText) {
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

  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. EXTRACT PRICE
  let price = 0;
  const priceRegexes = [
    /(?:باھاسى|باھا|باھاسىنى|باھاسى\s*:|نەرقى|السعر|سعر|Price|price|ئارانلا|نەق)\s*[:：\-]?\s*([¥$€]?\s*[0-9]+(?:\.[0-9]+)?)/i,
    /([0-9]+(?:\.[0-9]+)?)\s*(?:يۈەن|تۈمەن|سوم|TL|USD|\$|¥|ريال|درهم|lira|tl)/i,
    /[¥$]\s*([0-9]+(?:\.[0-9]+)?)/,
    /([0-9]+(?:\.[0-9]+)?)\s*[\$¥]/
  ];

  for (const regex of priceRegexes) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      const numStr = match[1].replace(/[^0-9.]/g, '');
      const parsed = parseFloat(numStr);
      if (!isNaN(parsed) && parsed > 0) {
        price = parsed;
        break;
      }
    }
  }

  // Fallback: search lines for prices >= 50
  if (price === 0) {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const matches = line.match(/\b([1-9][0-9]{2,5})\b/g);
      if (matches && matches.length > 0) {
        price = parseFloat(matches[0]);
        break;
      }
    }
  }

  // 2. EXTRACT BRAND
  let brand = 'Apple';
  const brandKeywords = [
    { name: 'Apple', pattern: /(?:iPhone|iPad|MacBook|Apple|ئالما|آبل|AirPods|iWatch)/i },
    { name: 'Samsung', pattern: /(?:Samsung|Galaxy|سامسۇڭ|سامسونج|Ultra|S24|S25|Z Fold)/i },
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
  if (/(?:iPad|Pad|Tablet|پەد|تاختا كومپيۇتېر|تابلت|لوحي)/i.test(cleanText)) {
    categoryId = 'tablets';
  } else if (/(?:Watch|سائەت|ساعة|Ultra 2|Band|سائىتى)/i.test(cleanText)) {
    categoryId = 'watches';
  } else if (/(?:Charger|قۇۋۋەتلىگۈچ|شاحن|AirPods|قۇلاقلىق|سماعة|Cable|Case|زاپچاس)/i.test(cleanText)) {
    categoryId = 'accessories';
  }

  // 4. EXTRACT TITLE / PRODUCT NAME
  let nameUg = lines[0] || 'Noor Product';
  // Strip special symbols from beginning and end of title
  nameUg = nameUg.replace(/^[✨🔥🌟💥⭐\s\-_|#]+|[✨🔥🌟💥⭐\s\-_|#]+$/g, '').trim();
  if (nameUg.toWellFormed) {
    nameUg = nameUg.toWellFormed();
  }

  // 5. EXTRACT CLEAN DESCRIPTION
  // Filter out redundant pricing lines or raw link lines from description
  const cleanDescLines = lines.slice(1).filter(l => {
    return !l.includes('http') && !l.includes('t.me') && !l.includes('chat.whatsapp');
  });

  let descriptionUg = cleanDescLines.join('\n').trim() || cleanText;
  if (descriptionUg.toWellFormed) {
    descriptionUg = descriptionUg.toWellFormed();
  }

  const specsUg = `Marka: ${brand} | Turi: ${categoryId} | Holati: Yangi`;

  return {
    nameUg: nameUg.trim() || 'Noor Product',
    nameAr: nameUg.trim() || 'Noor Product',
    nameEn: nameUg.trim() || 'Noor Product',
    price: Number(price) || 0,
    originalPrice: Number(price) > 0 ? Number(price) * 1.1 : 0,
    categoryId,
    brand,
    descriptionUg,
    descriptionAr: descriptionUg,
    descriptionEn: descriptionUg,
    specsUg,
    specsAr: specsUg,
    specsEn: specsUg,
    isFeatured: true,
    inStock: true
  };
}

export const parseProductMessage = parseProductWithAI;

