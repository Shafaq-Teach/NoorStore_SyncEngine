import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

async function test() {
  const tables = ['products', 'orders', 'categories', 'coupons', 'reviews', 'app_settings', 'settings', 'config'];
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select('*').limit(1);
    console.log(`Table '${t}':`, error ? `Error: ${error.message}` : `OK (count: ${data?.length})`);
  }
}
test();
