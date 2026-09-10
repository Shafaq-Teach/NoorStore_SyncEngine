import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

async function test() {
  const row = {
    id: 999999,
    product_id: 1,
    user_name: '__SYNC_STATE__',
    comment: 'test state',
    rating: 5,
    timestamp: Date.now()
  };
  const { data, error } = await supabase.from('reviews').upsert([row]).select();
  console.log('Upsert result:', { data, error: error?.message });
}
test();
