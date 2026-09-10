import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

async function test() {
  const { data: existing, error: fetchErr } = await supabase.from('reviews').select('*').eq('user_name', '__ADMIN_PIN__').maybeSingle();
  console.log('Existing PIN row in Supabase:', existing);

  if (!existing) {
    const { data: inserted, error: insertErr } = await supabase.from('reviews').insert([{
      id: 888888,
      product_id: 1,
      user_name: '__ADMIN_PIN__',
      comment: '1234',
      rating: 5,
      timestamp: Date.now()
    }]).select();
    console.log('Inserted default PIN row:', inserted, insertErr);
  }
}
test();
