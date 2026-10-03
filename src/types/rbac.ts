// ============================================================================
// WifhPaws RBAC Types
// Shared type definitions for the three-tier role-based access control system.
// ============================================================================

/**
 * The four distinct role tiers in the WifhPaws RBAC hierarchy.
 *
 * Tier 0 — `global_master`: One of the 3 hardcoded founders. Can bootstrap projects.
 * Tier 1 — `project_owner`: Root authority for a specific project instance.
 * Tier 2a — `super_admin`: Project-level treasury & financial operations.
 * Tier 2b — `mod`: Trivia, games, chat moderation only — NO financial access.
 */
export type RbacRole = 'global_master' | 'project_owner' | 'super_admin' | 'mod';

/** Numeric authority weight used for hierarchy comparisons. Higher = more authority. */
export const ROLE_WEIGHT: Record<RbacRole, number> = {
  global_master: 100,
  project_owner: 80,
  super_admin: 60,
  mod: 40,
};

/** A row from the `project_instances` table. */
export interface ProjectInstance {
  id: string;
  chat_id: number;
  project_name: string | null;
  owner_telegram_id: number;
  bootstrapped_by: number;
  created_at: string;
  updated_at: string;
}

/** A row from the `project_roles` table. */
export interface ProjectRole {
  id: string;
  project_id: string;
  telegram_id: number;
  username: string | null;
  role: RbacRole;
  appointed_by: number;
  created_at: string;
  updated_at: string;
}

/** A row from the `telegram_user_cache` table. */
export interface TelegramUserCacheEntry {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  last_seen_at: string;
}
