import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

async function test() {
  const { data, error } = await supabase.from('reviews').select('*').eq('id', 999999).maybeSingle();
  console.log('Cloud sync state in Supabase:', { 
    found: !!data, 
    user_name: data?.user_name,
    commentPreview: data?.comment?.slice(0, 100)
  });
}
test();
