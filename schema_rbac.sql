-- ==============================================================================
-- WifhPaws Three-Tier RBAC Schema Migration
-- Run this in your Supabase SQL Editor AFTER the base schema.sql
-- ==============================================================================

-- 1. Project Instances table — one row per bootstrapped group/project
CREATE TABLE IF NOT EXISTS public.project_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id BIGINT NOT NULL UNIQUE,            -- Telegram group chat ID
    project_name TEXT,                          -- Optional human-readable project name
    owner_telegram_id BIGINT NOT NULL,          -- Tier 1: Project Owner
    bootstrapped_by BIGINT NOT NULL,            -- Tier 0: Global Master who ran /initproject
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Project Roles table — maps Telegram users to roles within a specific project
--    Roles: 'global_master', 'project_owner', 'super_admin', 'mod'
CREATE TABLE IF NOT EXISTS public.project_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.project_instances(id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL,
    username TEXT,                              -- Cached Telegram @handle for display
    role TEXT NOT NULL CHECK (role IN ('global_master', 'project_owner', 'super_admin', 'mod')),
    appointed_by BIGINT NOT NULL,              -- Who granted this role
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, telegram_id)           -- One role per user per project
);

-- 3. Username-to-ID resolution cache — maps @handles to immutable numeric IDs
CREATE TABLE IF NOT EXISTS public.telegram_user_cache (
    telegram_id BIGINT PRIMARY KEY,
    username TEXT,                              -- Most recently observed @handle (lowercase)
    first_name TEXT,
    last_name TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_project_instances_chat_id ON public.project_instances (chat_id);
CREATE INDEX IF NOT EXISTS idx_project_instances_owner ON public.project_instances (owner_telegram_id);
CREATE INDEX IF NOT EXISTS idx_project_roles_project_id ON public.project_roles (project_id);
CREATE INDEX IF NOT EXISTS idx_project_roles_telegram_id ON public.project_roles (telegram_id);
CREATE INDEX IF NOT EXISTS idx_project_roles_role ON public.project_roles (role);
CREATE INDEX IF NOT EXISTS idx_telegram_user_cache_username ON public.telegram_user_cache (LOWER(username));

-- 5. Row Level Security
ALTER TABLE public.project_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_user_cache ENABLE ROW LEVEL SECURITY;

-- Allow service-role (server-side bot) full access
CREATE POLICY "Service access to project_instances"
ON public.project_instances FOR ALL
USING (true) WITH CHECK (true);

CREATE POLICY "Service access to project_roles"
ON public.project_roles FOR ALL
USING (true) WITH CHECK (true);

CREATE POLICY "Service access to telegram_user_cache"
ON public.telegram_user_cache FOR ALL
USING (true) WITH CHECK (true);
