import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load .env FIRST before reading any env vars
dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    '[supabaseClient] Missing environment variables: SUPABASE_URL and/or SUPABASE_ANON_KEY. ' +
    'Make sure your .env file is in the project root and contains both values.'
  );
}

// Initialise Supabase client – values must be defined in .env
export const supabase: SupabaseClient = createClient(url, key);
