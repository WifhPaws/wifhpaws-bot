-- ==============================================================================
-- WifhPaws Telegram Bot Database Schema Migration
-- Run this script in your Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql
-- ==============================================================================

-- 1. Create the 'users' table
CREATE TABLE IF NOT EXISTS public.users (
    telegram_id BIGINT PRIMARY KEY,
    username TEXT,
    points INT NOT NULL DEFAULT 0,
    wallet_address TEXT,
    last_awarded_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for high performance
-- Fast query for /leaderboard
CREATE INDEX IF NOT EXISTS idx_users_points_desc ON public.users (points DESC);

-- Fast lookup for /airdrop @handle
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON public.users (LOWER(username));

-- 3. Stored Procedure for Atomic Points Increment & Upsert
-- This prevents race conditions when awarding points or executing airdrops
CREATE OR REPLACE FUNCTION public.increment_user_points(
    p_telegram_id BIGINT,
    p_username TEXT,
    p_points INT,
    p_last_awarded_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS public.users
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result public.users;
BEGIN
    INSERT INTO public.users (
        telegram_id,
        username,
        points,
        last_awarded_at,
        created_at,
        updated_at
    )
    VALUES (
        p_telegram_id,
        p_username,
        p_points,
        COALESCE(p_last_awarded_at, NOW()),
        NOW(),
        NOW()
    )
    ON CONFLICT (telegram_id) DO UPDATE
    SET
        username = COALESCE(EXCLUDED.username, public.users.username),
        points = public.users.points + EXCLUDED.points,
        last_awarded_at = CASE 
            WHEN p_last_awarded_at IS NOT NULL THEN p_last_awarded_at 
            ELSE public.users.last_awarded_at 
        END,
        updated_at = NOW()
    RETURNING * INTO v_result;

    RETURN v_result;
END;
$$;

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Allow read/write access
CREATE POLICY "Allow public read access to leaderboard" 
ON public.users 
FOR SELECT 
USING (true);

CREATE POLICY "Allow authenticated/service role full access" 
ON public.users 
FOR ALL 
USING (true)
WITH CHECK (true);
