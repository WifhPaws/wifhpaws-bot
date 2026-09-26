import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Initialise Supabase client – values must be defined in .env
export const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_ANON_KEY ?? ''
);
