import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

async function test() {
  const { data, error } = await supabase.from('reviews').select('*').limit(5);
  console.log('reviews row:', data);
}
test();
