-- ==============================================================================
-- WifhPaws Telegram Bot Database Schema Migration
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/vwqfrofbwlsbroevjhib/sql/new
-- ==============================================================================

-- 1. Ensure 'users' table has both 'points' and 'paw_points' columns
CREATE TABLE IF NOT EXISTS public.users (
    telegram_id BIGINT PRIMARY KEY,
    username TEXT,
    points INT NOT NULL DEFAULT 0,
    paw_points INT NOT NULL DEFAULT 0,
    wallet_address TEXT,
    last_awarded_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- In case 'users' table already exists, ensure 'paw_points' column is present
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS paw_points INT DEFAULT 0;

-- Sync any existing points to paw_points if paw_points is 0
UPDATE public.users SET paw_points = points WHERE (paw_points IS NULL OR paw_points = 0) AND points > 0;

-- 2. Create 'user_wallets' table for Custodial Wallets
CREATE TABLE IF NOT EXISTS public.user_wallets (
    telegram_id BIGINT PRIMARY KEY,
    public_address TEXT NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create 'dynamic_keywords' table for Admin-managed rewarded keywords
CREATE TABLE IF NOT EXISTS public.dynamic_keywords (
    keyword TEXT PRIMARY KEY,
    points_reward INT NOT NULL DEFAULT 10,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default trigger keywords
INSERT INTO public.dynamic_keywords (keyword, points_reward)
VALUES 
    ('gm', 10),
    ('thanks', 10),
    ('thank you', 10),
    ('ty', 10),
    ('lfg', 10)
ON CONFLICT (keyword) DO NOTHING;

-- 4. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_paw_points_desc ON public.users (paw_points DESC);
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON public.users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_user_wallets_address ON public.user_wallets (public_address);

-- 5. Row Level Security (RLS)
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dynamic_keywords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public access to user_wallets" 
ON public.user_wallets 
FOR ALL 
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow public access to dynamic_keywords" 
ON public.dynamic_keywords 
FOR ALL 
USING (true)
WITH CHECK (true);
