import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

async function test() {
  const { data, error } = await supabase.from('sync_settings').select('*').limit(1);
  console.log('sync_settings query result:', { data, error: error?.message });
}
test();
