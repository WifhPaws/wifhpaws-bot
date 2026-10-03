// ============================================================================
// WifhPaws RBAC Database Service
// All Supabase interactions for the three-tier role system live here.
// ============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  RbacRole,
  ProjectInstance,
  ProjectRole,
  TelegramUserCacheEntry,
} from '../types/rbac';

dotenv.config();

// ---------------------------------------------------------------------------
// Supabase Client (service-role for server-side operations)
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('[rbacService] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return _client;
}

// ============================================================================
// GLOBAL MASTER IDS (Tier 0)
// ============================================================================

/**
 * Parse the comma-separated GLOBAL_MASTER_IDS env var into an array of numbers.
 * These are the 3 founder Telegram IDs with absolute authority.
 */
export const GLOBAL_MASTER_IDS: number[] = (process.env.GLOBAL_MASTER_IDS || '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

/** Check if a Telegram user ID is one of the 3 Global Masters. */
export function isGlobalMaster(telegramId: number): boolean {
  return GLOBAL_MASTER_IDS.includes(telegramId);
}

// ============================================================================
// TELEGRAM USER CACHE (handle ↔ numeric ID resolution)
// ============================================================================

/**
 * Upserts a user into the cache whenever the bot observes their activity.
 * This ensures we can always resolve @handles to immutable numeric IDs.
 */
export async function upsertUserCache(
  telegramId: number,
  username: string | null,
  firstName: string | null = null,
  lastName: string | null = null
): Promise<void> {
  const sb = getClient();
  const row: Record<string, unknown> = {
    telegram_id: telegramId,
    username: username?.toLowerCase().replace(/^@/, '') || null,
    first_name: firstName,
    last_name: lastName,
    last_seen_at: new Date().toISOString(),
  };

  await sb.from('telegram_user_cache').upsert(row, { onConflict: 'telegram_id' });
}

/**
 * Resolves a @username (case-insensitive) to its cached numeric Telegram ID.
 * Returns null if the user has never interacted with the bot.
 */
export async function resolveUsernameToId(
  handle: string
): Promise<TelegramUserCacheEntry | null> {
  const sb = getClient();
  const clean = handle.replace(/^@/, '').trim().toLowerCase();
  if (!clean) return null;

  const { data, error } = await sb
    .from('telegram_user_cache')
    .select('*')
    .ilike('username', clean)
    .single();

  if (error || !data) return null;
  return data as TelegramUserCacheEntry;
}

/**
 * Attempts to resolve an argument that may be either a numeric ID or a @handle.
 * Returns the numeric Telegram ID or null if unresolvable.
 */
export async function resolveUserArg(arg: string): Promise<number | null> {
  const cleaned = arg.replace(/^@/, '').trim();

  // If purely numeric, treat as a Telegram ID directly
  if (/^\d+$/.test(cleaned)) {
    return parseInt(cleaned, 10);
  }

  // Otherwise resolve the @handle from the cache
  const cached = await resolveUsernameToId(cleaned);
  return cached?.telegram_id ?? null;
}

// ============================================================================
// PROJECT INSTANCES
// ============================================================================

/** Look up the project instance for a given Telegram group chat ID. */
export async function getProjectByChatId(
  chatId: number
): Promise<ProjectInstance | null> {
  const sb = getClient();
  const { data, error } = await sb
    .from('project_instances')
    .select('*')
    .eq('chat_id', chatId)
    .single();

  if (error || !data) return null;
  return data as ProjectInstance;
}

/** Look up a project instance by its UUID. */
export async function getProjectById(
  projectId: string
): Promise<ProjectInstance | null> {
  const sb = getClient();
  const { data, error } = await sb
    .from('project_instances')
    .select('*')
    .eq('id', projectId)
    .single();

  if (error || !data) return null;
  return data as ProjectInstance;
}

/**
 * Bootstrap a new project instance. Called exclusively by a Global Master.
 *
 * Creates the project row and inserts two role records:
 *  1. The Global Master who ran the command → `global_master`
 *  2. The designated owner → `project_owner`
 */
export async function bootstrapProject(
  chatId: number,
  ownerTelegramId: number,
  bootstrappedByTelegramId: number,
  projectName?: string,
  ownerUsername?: string | null
): Promise<ProjectInstance> {
  const sb = getClient();

  // Prevent duplicate bootstrapping
  const existing = await getProjectByChatId(chatId);
  if (existing) {
    throw new Error(
      `This group (chat_id=${chatId}) is already bootstrapped as project "${existing.project_name || existing.id}".`
    );
  }

  // Insert the project instance
  const { data: project, error: projErr } = await sb
    .from('project_instances')
    .insert({
      chat_id: chatId,
      project_name: projectName || null,
      owner_telegram_id: ownerTelegramId,
      bootstrapped_by: bootstrappedByTelegramId,
    })
    .select('*')
    .single();

  if (projErr || !project) {
    throw new Error(`Failed to create project instance: ${projErr?.message || 'Unknown error'}`);
  }

  // Insert the project_owner role
  await sb.from('project_roles').insert({
    project_id: project.id,
    telegram_id: ownerTelegramId,
    username: ownerUsername?.toLowerCase().replace(/^@/, '') || null,
    role: 'project_owner' as RbacRole,
    appointed_by: bootstrappedByTelegramId,
  });

  // Also insert a global_master role row for the bootstrapper so their
  // authority is tracked per-project too
  await sb.from('project_roles').upsert(
    {
      project_id: project.id,
      telegram_id: bootstrappedByTelegramId,
      role: 'global_master' as RbacRole,
      appointed_by: bootstrappedByTelegramId,
    },
    { onConflict: 'project_id,telegram_id' }
  );

  return project as ProjectInstance;
}

// ============================================================================
// ROLE MANAGEMENT
// ============================================================================

/** Get a user's role within a project. Returns null if the user has no role. */
export async function getUserRole(
  projectId: string,
  telegramId: number
): Promise<ProjectRole | null> {
  const sb = getClient();
  const { data, error } = await sb
    .from('project_roles')
    .select('*')
    .eq('project_id', projectId)
    .eq('telegram_id', telegramId)
    .single();

  if (error || !data) return null;
  return data as ProjectRole;
}

/**
 * Determine the effective role for a user within a project, accounting for
 * Global Master override (Tier 0 always outranks everything).
 */
export async function getEffectiveRole(
  projectId: string,
  telegramId: number
): Promise<RbacRole | null> {
  // Global Masters always have global_master authority
  if (isGlobalMaster(telegramId)) return 'global_master';

  const role = await getUserRole(projectId, telegramId);
  return role?.role ?? null;
}

/** Check if the given user is the project owner for a project. */
export async function isProjectOwner(
  projectId: string,
  telegramId: number
): Promise<boolean> {
  const project = await getProjectById(projectId);
  if (!project) return false;
  return project.owner_telegram_id === telegramId;
}

/**
 * Assign or update a role for a user within a project (upsert).
 * Returns the resulting role record.
 */
export async function setUserRole(
  projectId: string,
  telegramId: number,
  role: RbacRole,
  appointedBy: number,
  username?: string | null
): Promise<ProjectRole> {
  const sb = getClient();

  const { data, error } = await sb
    .from('project_roles')
    .upsert(
      {
        project_id: projectId,
        telegram_id: telegramId,
        username: username?.toLowerCase().replace(/^@/, '') || null,
        role,
        appointed_by: appointedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,telegram_id' }
    )
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to set role: ${error?.message || 'Unknown error'}`);
  }

  return data as ProjectRole;
}

/** Remove a user's role entirely from a project. */
export async function removeUserRole(
  projectId: string,
  telegramId: number
): Promise<boolean> {
  const sb = getClient();

  const { error } = await sb
    .from('project_roles')
    .delete()
    .eq('project_id', projectId)
    .eq('telegram_id', telegramId);

  return !error;
}

/** List all roles for a specific project. */
export async function listProjectRoles(
  projectId: string
): Promise<ProjectRole[]> {
  const sb = getClient();

  const { data, error } = await sb
    .from('project_roles')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error || !data) return [];
  return data as ProjectRole[];
}

/**
 * Check if a user holds a role at or above a minimum tier within the project.
 * Tier hierarchy: global_master > project_owner > super_admin > mod
 */
export async function hasMinimumRole(
  projectId: string,
  telegramId: number,
  minimumRole: RbacRole
): Promise<boolean> {
  const effectiveRole = await getEffectiveRole(projectId, telegramId);
  if (!effectiveRole) return false;

  const weights: Record<RbacRole, number> = {
    global_master: 100,
    project_owner: 80,
    super_admin: 60,
    mod: 40,
  };

  return weights[effectiveRole] >= weights[minimumRole];
}
