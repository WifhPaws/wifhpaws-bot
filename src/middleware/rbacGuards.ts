// ============================================================================
// WifhPaws RBAC Guard Middleware
// Reusable guard functions that verify a caller's authority level before
// allowing sensitive bot commands to proceed.
// ============================================================================

import { Context, MiddlewareFn } from 'telegraf';
import {
  isGlobalMaster,
  getProjectByChatId,
  getEffectiveRole,
  isProjectOwner,
  hasMinimumRole,
  upsertUserCache,
} from '../services/rbacService';
import { RbacRole, ROLE_WEIGHT } from '../types/rbac';

// ---------------------------------------------------------------------------
// Helper: Extract project context from a Telegram message
// ---------------------------------------------------------------------------

/**
 * Resolves the current chat to a registered project instance.
 * Returns null if the chat is not bootstrapped.
 */
async function resolveProject(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  return getProjectByChatId(chatId);
}

// ---------------------------------------------------------------------------
// Middleware: Auto-cache every user the bot observes
// ---------------------------------------------------------------------------

/**
 * Telegraf middleware that caches the sender's Telegram ID ↔ @handle mapping
 * on every interaction. This ensures handle-to-ID resolution is always fresh.
 */
export const cacheUserMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const from = ctx.from;
  if (from && !from.is_bot) {
    // Fire-and-forget; don't block the request
    upsertUserCache(
      from.id,
      from.username || null,
      from.first_name || null,
      from.last_name || null
    ).catch(() => {});
  }

  // Also cache users mentioned via text_mention entities in group messages.
  // text_mention entities include the full user object (with numeric ID),
  // unlike plain @mention entities which only have the username text.
  const message = (ctx as any).message;
  if (message?.entities) {
    for (const entity of message.entities) {
      if (entity.type === 'text_mention' && entity.user && !entity.user.is_bot) {
        upsertUserCache(
          entity.user.id,
          entity.user.username || null,
          entity.user.first_name || null,
          entity.user.last_name || null
        ).catch(() => {});
      }
    }
  }

  return next();
};

// ---------------------------------------------------------------------------
// Guard: Global Master Only (Tier 0)
// ---------------------------------------------------------------------------

/**
 * Blocks execution unless the sender is one of the 3 hardcoded Global Masters.
 * Use for: `/initproject` (bootstrap)
 */
export const globalMasterOnly: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !isGlobalMaster(userId)) {
    await ctx.reply(
      '⛔ *Access Denied*\n\n' +
      'This command is restricted to Global Masters (Tier 0 founders).',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  return next();
};

// ---------------------------------------------------------------------------
// Guard: Project Owner Only (Tier 1)
// ---------------------------------------------------------------------------

/**
 * Blocks execution unless the sender is the Project Owner for the current chat.
 * Use for: `/promotesuper`, `/demote`, `/removeadmin`
 */
export const projectOwnerOnly: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('⛔ Could not identify your Telegram user ID.');
    return;
  }

  // Global Masters bypass everything
  if (isGlobalMaster(userId)) return next();

  const project = await resolveProject(ctx);
  if (!project) {
    await ctx.reply(
      '⚠️ *No Project Registered*\n\n' +
      'This group has not been initialized yet. Ask a Global Master to run `/initproject`.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!(await isProjectOwner(project.id, userId))) {
    await ctx.reply(
      '⛔ *Access Denied*\n\n' +
      'Only the *Project Owner* (Tier 1) can execute this command.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  return next();
};

// ---------------------------------------------------------------------------
// Guard: Minimum Role Required
// ---------------------------------------------------------------------------

/**
 * Factory that creates a guard middleware requiring the user to hold at least
 * the specified role within the current project.
 *
 * Example: `requireRole('super_admin')` blocks mods and unregistered users
 * but allows super_admins, project owners, and global masters.
 */
export function requireRole(minimumRole: RbacRole): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('⛔ Could not identify your Telegram user ID.');
      return;
    }

    // Global Masters bypass everything
    if (isGlobalMaster(userId)) return next();

    const project = await resolveProject(ctx);
    if (!project) {
      await ctx.reply(
        '⚠️ *No Project Registered*\n\n' +
        'This group has not been initialized yet. Ask a Global Master to run `/initproject`.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const allowed = await hasMinimumRole(project.id, userId, minimumRole);
    if (!allowed) {
      const roleName = minimumRole.replace(/_/g, ' ');
      await ctx.reply(
        `⛔ *Access Denied*\n\n` +
        `This command requires at least *${roleName}* privileges.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Guard: Financial Operations (Super Admin+)
// ---------------------------------------------------------------------------

/**
 * Blocks mods from executing financial commands (treasury, airdrop, etc.).
 * Only super_admins, project owners, and global masters may proceed.
 */
export const financialOpsOnly: MiddlewareFn<Context> = requireRole('super_admin');

// ---------------------------------------------------------------------------
// Guard: Moderation Operations (Mod+)
// ---------------------------------------------------------------------------

/**
 * Requires at least mod-level authority.
 * Allows: mod, super_admin, project_owner, global_master.
 */
export const moderatorOnly: MiddlewareFn<Context> = requireRole('mod');

// ---------------------------------------------------------------------------
// Programmatic guard (non-middleware)
// ---------------------------------------------------------------------------

/**
 * Non-middleware helper for inline permission checks within command handlers.
 * Returns `true` if the user meets or exceeds the required role.
 */
export async function checkPermission(
  chatId: number,
  telegramId: number,
  minimumRole: RbacRole
): Promise<boolean> {
  if (isGlobalMaster(telegramId)) return true;

  const project = await getProjectByChatId(chatId);
  if (!project) return false;

  return hasMinimumRole(project.id, telegramId, minimumRole);
}
