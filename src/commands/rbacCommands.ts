// ============================================================================
// WifhPaws RBAC Command Handlers
// All bot commands for the three-tier white-label RBAC system.
//
// ✅ ALL admin commands work in PRIVATE DMs (preferred) AND group chats.
//    In DMs: auto-selects the project if user is in exactly one, otherwise
//            prompts with /selectproject.
//    In groups: uses the group's chat_id to identify the project.
//
// Commands implemented:
//   /initproject    — Global Masters only: bootstrap a project (group-only)
//   /addadmin       — Project Owner / Super Admin: add a mod
//   /promotesuper   — Project Owner only: elevate mod → super_admin
//   /demote         — Project Owner only: demote super_admin → mod
//   /removeadmin    — Project Owner only: strip all admin privileges
//   /roles          — List all roles for the current project
//   /myrole         — Show the caller's role in the current project
//   /selectproject  — Choose which project to manage in DMs
//   /rbachelp       — Display RBAC command help organized by tier
// ============================================================================

import { Telegraf, Context, Markup } from 'telegraf';
import {
  isGlobalMaster,
  GLOBAL_MASTER_IDS,
  getProjectByChatId,
  getProjectById,
  bootstrapProject,
  getUserRole,
  getEffectiveRole,
  isProjectOwner,
  setUserRole,
  removeUserRole,
  listProjectRoles,
  resolveUserArg,
  resolveUsernameToId,
  upsertUserCache,
  hasMinimumRole,
  getProjectsForUser,
} from '../services/rbacService';
import {
  globalMasterOnly,
  projectOwnerOnly,
  requireRole,
} from '../middleware/rbacGuards';
import { RbacRole, ROLE_WEIGHT, ProjectInstance } from '../types/rbac';

const ROLE_EMOJI: Record<RbacRole, string> = {
  global_master: '👑',
  project_owner: '🏛️',
  super_admin: '⭐',
  mod: '🛡️',
};

const ROLE_LABEL: Record<RbacRole, string> = {
  global_master: 'Global Master',
  project_owner: 'Project Owner',
  super_admin: 'Super Admin',
  mod: 'Moderator',
};

// ---------------------------------------------------------------------------
// IN-MEMORY: Active project selection for DM-based management
// Maps userId → projectId
// ---------------------------------------------------------------------------
const activeProjectMap = new Map<number, string>();

// ---------------------------------------------------------------------------
// Helper: Resolve which project the user is managing
// - In group chat: looks up the project by chat_id
// - In DM: uses activeProjectMap or auto-selects if user has exactly 1 project
// ---------------------------------------------------------------------------
async function resolveProject(
  ctx: Context
): Promise<{ project: ProjectInstance | null; error?: string }> {
  const chatType = ctx.chat?.type;
  const userId = ctx.from?.id;
  if (!userId) return { project: null, error: '⛔ Could not identify your user.' };

  // ── Group chat: use chat_id ──
  if (chatType === 'group' || chatType === 'supergroup') {
    const project = await getProjectByChatId(ctx.chat!.id);
    if (!project) {
      return {
        project: null,
        error: '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject` in the group.',
      };
    }
    return { project };
  }

  // ── Private DM: resolve from memory or auto-select ──
  const activeId = activeProjectMap.get(userId);
  if (activeId) {
    const proj = await getProjectById(activeId);
    if (proj) return { project: proj };
    // Stale selection, clear it
    activeProjectMap.delete(userId);
  }

  // Auto-select if user is in exactly one project
  const projects = await getProjectsForUser(userId);
  if (projects.length === 0) {
    return {
      project: null,
      error: '⚠️ You don\'t have a role in any project yet.\nAsk a Global Master to run `/initproject` in a group first.',
    };
  }
  if (projects.length === 1) {
    activeProjectMap.set(userId, projects[0].id);
    return { project: projects[0] };
  }

  // Multiple projects — need selection
  let list = '📋 *You have roles in multiple projects:*\n\n';
  projects.forEach((p, i) => {
    list += `${i + 1}. ${p.project_name || `Project ${p.id.slice(0, 8)}`} (chat: \`${p.chat_id}\`)\n`;
  });
  list += `\nUse \`/selectproject <number>\` to choose which project to manage.`;

  return { project: null, error: list };
}

// ---------------------------------------------------------------------------
// Helper: Parse the target user from a command (reply-to or @handle or ID)
// ---------------------------------------------------------------------------
async function parseTargetArg(ctx: Context): Promise<{
  telegramId: number | null;
  displayName: string;
  error?: string;
}> {
  const message = ctx.message as any;
  if (!message) {
    return { telegramId: null, displayName: '', error: 'No command text found.' };
  }

  // ── Method 1: Reply-to-message (most reliable) ──
  if (message.reply_to_message?.from && !message.reply_to_message.from.is_bot) {
    const target = message.reply_to_message.from;
    const displayName = target.username ? `@${target.username}` : (target.first_name || `ID:${target.id}`);

    // Cache the user for future lookups
    await upsertUserCache(
      target.id,
      target.username || null,
      target.first_name || null,
      target.last_name || null
    );

    return { telegramId: target.id, displayName };
  }

  // ── Method 2: Parse from command args ──
  const args = (message.text || '').trim().split(/\s+/).slice(1);
  if (args.length === 0) {
    return {
      telegramId: null,
      displayName: '',
      error: 'Please provide a @username or numeric Telegram ID.\n\n💡 In group chats, you can also *reply* to their message.',
    };
  }

  const rawArg = args[0];
  const displayName = rawArg.startsWith('@') ? rawArg : `ID:${rawArg}`;

  // ── Method 2a: Check for text_mention entities (contains full user object with ID) ──
  // Telegram provides text_mention entities when a user is mentioned by name
  // (not by @handle). These always include the user's numeric ID.
  const entities = message.entities || [];
  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user) {
      const user = entity.user;
      // Cache this user for future lookups
      await upsertUserCache(
        user.id,
        user.username || null,
        user.first_name || null,
        user.last_name || null
      );
      const name = user.username ? `@${user.username}` : (user.first_name || `ID:${user.id}`);
      return { telegramId: user.id, displayName: name };
    }
  }

  // ── Method 2b: Standard cache/DB resolution ──
  const resolved = await resolveUserArg(rawArg);

  if (resolved) {
    return { telegramId: resolved, displayName };
  }

  // ── Method 2c: Last resort — try Telegram's getChat API ──
  // This works for users who have a public username, even if they've
  // never interacted with the bot. Telegram's getChat accepts @username.
  if (rawArg.startsWith('@')) {
    try {
      const chatInfo = await ctx.telegram.getChat(rawArg);
      if (chatInfo && 'id' in chatInfo && chatInfo.type === 'private') {
        const userId = chatInfo.id;
        const username = ('username' in chatInfo ? chatInfo.username : null) || rawArg.replace(/^@/, '');
        const firstName = ('first_name' in chatInfo ? chatInfo.first_name : null) || null;
        const lastName = ('last_name' in chatInfo ? chatInfo.last_name : null) || null;

        // Cache for future lookups
        await upsertUserCache(userId, username, firstName, lastName);

        const name = username ? `@${username}` : (firstName || `ID:${userId}`);
        return { telegramId: userId, displayName: name };
      }
    } catch {
      // getChat failed — user may not exist or bot can't access
    }
  }

  return {
    telegramId: null,
    displayName,
    error:
      `Could not resolve \`${displayName}\` to a Telegram user.\n\n` +
      `🔧 *Try instead:*\n` +
      `• Use their *numeric Telegram ID*\n` +
      `• In group chat, *reply* to their message\n` +
      `• Have them send /start to the bot first\n\n` +
      `💡 Find a user's ID: forward their message to @userinfobot`,
  };
}

// ---------------------------------------------------------------------------
// Helper: RBAC permission check that works in both groups and DMs
// ---------------------------------------------------------------------------
async function checkRbacPermission(
  project: ProjectInstance,
  userId: number,
  minimumRole: RbacRole
): Promise<boolean> {
  if (isGlobalMaster(userId)) return true;
  return hasMinimumRole(project.id, userId, minimumRole);
}

// ============================================================================
// REGISTER ALL RBAC COMMANDS ON THE BOT
// ============================================================================

export function registerRbacCommands(bot: Telegraf<Context>): void {
  const BOT_USERNAME = process.env.BOT_USERNAME || '';

  // ─── /selectproject ────────────────────────────────────────────────────────
  // Choose which project to manage in DMs (for users in multiple projects).
  // Usage: /selectproject [number]
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(['selectproject', `selectproject@${BOT_USERNAME}`], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply('⛔ Could not identify your user ID.');

    const projects = await getProjectsForUser(userId);
    if (projects.length === 0) {
      return ctx.reply('⚠️ You don\'t have a role in any project yet.', { parse_mode: 'Markdown' });
    }

    const message = ctx.message as any;
    const args = (message?.text || '').trim().split(/\s+/).slice(1);

    if (args.length === 0) {
      // Show project list
      let text = '📋 *Your Projects:*\n\n';
      const currentId = activeProjectMap.get(userId);
      projects.forEach((p, i) => {
        const marker = p.id === currentId ? ' ✅' : '';
        text += `${i + 1}. ${p.project_name || `Project ${p.id.slice(0, 8)}`}${marker}\n`;
      });
      text += `\nUse \`/selectproject <number>\` to switch.`;
      return ctx.reply(text, { parse_mode: 'Markdown' });
    }

    const idx = parseInt(args[0], 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= projects.length) {
      return ctx.reply(`❌ Invalid selection. Choose a number between 1 and ${projects.length}.`);
    }

    activeProjectMap.set(userId, projects[idx].id);
    return ctx.reply(
      `✅ Active project set to: *${projects[idx].project_name || 'Unnamed'}*\n\nAll admin commands will now apply to this project.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── /initproject ──────────────────────────────────────────────────────────
  // Global Masters Only: Bootstrap a project instance for the current group.
  // This command MUST be run inside a group chat (needs the chat_id).
  //
  // Resolution methods (in priority order):
  //   1. Reply to a message from the designated owner
  //   2. Pass a numeric Telegram ID:  /initproject 123456789 "Project Name"
  //   3. Pass a @username:            /initproject @handle "Project Name"
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['initproject', `initproject@${BOT_USERNAME}`],
    globalMasterOnly,
    async (ctx) => {
      const senderId = ctx.from!.id;
      const chatId = ctx.chat!.id;

      if (ctx.chat!.type === 'private') {
        return ctx.reply(
          '⚠️ `/initproject` must be run inside a *group chat* to register that group as a project.\n\n' +
          '💡 All *other* admin commands (`/addadmin`, `/promotesuper`, etc.) work right here in DMs!',
          { parse_mode: 'Markdown' }
        );
      }

      const message = ctx.message as any;
      const args = (message?.text || '').trim().split(/\s+/).slice(1);

      // ── Method 1: Reply-to-message (most reliable) ──
      let ownerId: number | null = null;
      let ownerUsername: string | null = null;
      let projectName: string | undefined;

      if (message?.reply_to_message?.from && !message.reply_to_message.from.is_bot) {
        ownerId = message.reply_to_message.from.id;
        ownerUsername = message.reply_to_message.from.username || null;
        projectName = args.join(' ').replace(/"/g, '') || undefined;

        // Cache this user so future lookups work
        if (ownerUsername) {
          await upsertUserCache(ownerId!, ownerUsername,
            message.reply_to_message.from.first_name || null,
            message.reply_to_message.from.last_name || null
          );
        }
      } else {
        // ── Method 2, 3, & 4: Parse from command args ──
        if (args.length === 0) {
          return ctx.reply(
            '📋 *Usage (pick one):*\n\n' +
            '1️⃣ *Reply to a message* from the target user:\n' +
            '   → Reply to their message with `/initproject "Project Name"`\n\n' +
            '2️⃣ *Use their numeric Telegram ID:*\n' +
            '   → `/initproject 123456789 "Project Name"`\n\n' +
            '3️⃣ *Use their @handle:*\n' +
            '   → `/initproject @username "Project Name"`\n\n' +
            '4️⃣ *Make yourself the owner:*\n' +
            '   → `/initproject "Project Name"`\n\n' +
            '💡 *Tip:* Method 1 (reply) is the most reliable.\n' +
            '🔒 Only Global Masters can run this command.',
            { parse_mode: 'Markdown' }
          );
        }

        const firstArg = args[0];

        // If the first argument is a handle or a numeric ID
        if (firstArg.startsWith('@') || /^\d+$/.test(firstArg)) {
          const ownerArg = firstArg;
          projectName = args.slice(1).join(' ').replace(/"/g, '') || undefined;

          // Try resolving the argument
          ownerId = await resolveUserArg(ownerArg);
          if (ownerId) {
            const cache = await resolveUsernameToId(ownerArg.replace(/^@/, ''));
            ownerUsername = cache?.username || null;
          }
        } else {
          // Assume they didn't provide a user and just gave a project name
          // Make the sender (the Global Master) the owner
          ownerId = senderId;
          ownerUsername = ctx.from!.username || null;
          projectName = args.join(' ').replace(/"/g, '') || undefined;

          // Cache this user just in case
          await upsertUserCache(
            ownerId,
            ownerUsername,
            ctx.from!.first_name || null,
            ctx.from!.last_name || null
          );
        }
      }

      if (!ownerId) {
        return ctx.reply(
          `❌ Could not resolve the target user to a Telegram ID.\n\n` +
          `🔧 *Try one of these instead:*\n` +
          `• *Reply* to one of their messages with:\n  \`/initproject "Project Name"\`\n` +
          `• Use their *numeric ID*:\n  \`/initproject 123456789 "Project Name"\`\n\n` +
          `💡 You can find someone's numeric ID by forwarding their message to @userinfobot`,
          { parse_mode: 'Markdown' }
        );
      }

      try {
        const project = await bootstrapProject(
          chatId,
          ownerId,
          senderId,
          projectName,
          ownerUsername
        );

        const ownerDisplay = ownerUsername ? `@${ownerUsername}` : `ID: \`${ownerId}\``;
        return ctx.reply(
          `✅ *Project Bootstrapped Successfully!*\n\n` +
          `📌 *Project:* ${project.project_name || 'Unnamed'}\n` +
          `🏛️ *Owner (Tier 1):* ${ownerDisplay}\n` +
          `👑 *Bootstrapped by:* Global Master\n\n` +
          `💡 *You can now manage this project from DMs!*\n` +
          `The Project Owner can use these commands in their DM with the bot:\n` +
          `• \`/addadmin @user\` — Add moderators\n` +
          `• \`/promotesuper @user\` — Elevate mods to Super Admin\n` +
          `• \`/demote @user\` — Demote staff\n` +
          `• \`/removeadmin @user\` — Remove staff entirely`,
          { parse_mode: 'Markdown' }
        );
      } catch (err: any) {
        console.error('[initproject] Bootstrap error:', err);
        return ctx.reply(`❌ *Bootstrap Failed:* ${err.message}`, { parse_mode: 'Markdown' });
      }
    }
  );

  // ─── /addadmin ─────────────────────────────────────────────────────────────
  // Project Owner or Super Admin: Add a user as a standard Moderator (mod).
  // Works in both group chat and private DM.
  // Usage: /addadmin @username   OR   /addadmin 123456789
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['addadmin', `addadmin@${BOT_USERNAME}`],
    async (ctx) => {
      const senderId = ctx.from!.id;

      // Resolve the project (group or DM)
      const { project, error: projError } = await resolveProject(ctx);
      if (!project) {
        return ctx.reply(projError || '⚠️ No project found.', { parse_mode: 'Markdown' });
      }

      // Permission check: require super_admin or above
      const hasPermission = await checkRbacPermission(project, senderId, 'super_admin');
      if (!hasPermission) {
        return ctx.reply('⛔ You need *Super Admin* or higher to add admins.', { parse_mode: 'Markdown' });
      }

      const { telegramId: targetId, displayName, error } = await parseTargetArg(ctx);
      if (error || !targetId) {
        return ctx.reply(`❌ ${error || 'Invalid target.'}`, { parse_mode: 'Markdown' });
      }

      // Check if the target already has a role
      const existingRole = await getUserRole(project.id, targetId);
      if (existingRole) {
        return ctx.reply(
          `ℹ️ ${displayName} already has the role *${ROLE_LABEL[existingRole.role]}* in this project.`,
          { parse_mode: 'Markdown' }
        );
      }

      // Cannot add yourself
      if (targetId === senderId) {
        return ctx.reply('❌ You cannot add yourself as an admin.');
      }

      try {
        const targetCache = await resolveUsernameToId(displayName.replace(/^@/, ''));
        await setUserRole(
          project.id,
          targetId,
          'mod',
          senderId,
          targetCache?.username || null
        );

        return ctx.reply(
          `✅ *Moderator Added!*\n\n` +
          `${ROLE_EMOJI.mod} ${displayName} is now a *Moderator* (Tier 2b) in *${project.project_name || 'this project'}*.\n\n` +
          `They can manage trivia, games, and chat moderation.\n` +
          `🔒 They do *not* have access to treasury or financial operations.\n\n` +
          `💡 To grant financial access, the Project Owner can run:\n\`/promotesuper ${displayName}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (err: any) {
        return ctx.reply(`❌ Failed to add admin: ${err.message}`);
      }
    }
  );

  // ─── /promotesuper ─────────────────────────────────────────────────────────
  // Project Owner Only: Promote an existing mod to Super Admin.
  // Works in both group chat and private DM.
  // Usage: /promotesuper @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['promotesuper', `promotesuper@${BOT_USERNAME}`],
    async (ctx) => {
      const senderId = ctx.from!.id;

      const { project, error: projError } = await resolveProject(ctx);
      if (!project) {
        return ctx.reply(projError || '⚠️ No project found.', { parse_mode: 'Markdown' });
      }

      // Permission check: project owner or global master only
      const isOwner = project.owner_telegram_id === senderId;
      if (!isOwner && !isGlobalMaster(senderId)) {
        return ctx.reply('⛔ Only the *Project Owner* can promote to Super Admin.', { parse_mode: 'Markdown' });
      }

      const { telegramId: targetId, displayName, error } = await parseTargetArg(ctx);
      if (error || !targetId) {
        return ctx.reply(`❌ ${error || 'Invalid target.'}`, { parse_mode: 'Markdown' });
      }

      // Safety: Cannot promote the Project Owner
      if (targetId === project.owner_telegram_id) {
        return ctx.reply(
          '⚠️ The Project Owner already has the highest project-level authority and cannot be promoted further.',
          { parse_mode: 'Markdown' }
        );
      }

      // Check existing role
      const existingRole = await getUserRole(project.id, targetId);
      if (existingRole?.role === 'super_admin') {
        return ctx.reply(`ℹ️ ${displayName} is already a *Super Admin*.`, { parse_mode: 'Markdown' });
      }
      if (existingRole?.role === 'project_owner') {
        return ctx.reply(`⚠️ ${displayName} is the *Project Owner* — they cannot be changed.`, { parse_mode: 'Markdown' });
      }

      try {
        const targetCache = await resolveUsernameToId(displayName.replace(/^@/, ''));
        await setUserRole(
          project.id,
          targetId,
          'super_admin',
          senderId,
          targetCache?.username || null
        );

        return ctx.reply(
          `✅ *Promotion Successful!*\n\n` +
          `${ROLE_EMOJI.super_admin} ${displayName} is now a *Super Admin* (Tier 2a) in *${project.project_name || 'this project'}*.\n\n` +
          `🔓 *New Permissions Unlocked:*\n` +
          `• Treasury management\n` +
          `• Token airdrops & financial operations\n` +
          `• All moderator capabilities`,
          { parse_mode: 'Markdown' }
        );
      } catch (err: any) {
        return ctx.reply(`❌ Promotion failed: ${err.message}`);
      }
    }
  );

  // ─── /demote ───────────────────────────────────────────────────────────────
  // Project Owner Only: Demote a Super Admin back to Moderator.
  // Works in both group chat and private DM.
  // Usage: /demote @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['demote', `demote@${BOT_USERNAME}`],
    async (ctx) => {
      const senderId = ctx.from!.id;

      const { project, error: projError } = await resolveProject(ctx);
      if (!project) {
        return ctx.reply(projError || '⚠️ No project found.', { parse_mode: 'Markdown' });
      }

      const isOwner = project.owner_telegram_id === senderId;
      if (!isOwner && !isGlobalMaster(senderId)) {
        return ctx.reply('⛔ Only the *Project Owner* can demote staff.', { parse_mode: 'Markdown' });
      }

      const { telegramId: targetId, displayName, error } = await parseTargetArg(ctx);
      if (error || !targetId) {
        return ctx.reply(`❌ ${error || 'Invalid target.'}`, { parse_mode: 'Markdown' });
      }

      // SAFETY: The Project Owner can NEVER be demoted
      if (targetId === project.owner_telegram_id) {
        return ctx.reply(
          '🔒 *Safety Check Failed*\n\n' +
          'The Project Owner *cannot* be demoted. This is a protected immutable role.',
          { parse_mode: 'Markdown' }
        );
      }

      // Cannot demote a Global Master
      if (isGlobalMaster(targetId)) {
        return ctx.reply(
          '🔒 *Safety Check Failed*\n\n' +
          'Global Masters (Tier 0) cannot be demoted by anyone.',
          { parse_mode: 'Markdown' }
        );
      }

      const existingRole = await getUserRole(project.id, targetId);
      if (!existingRole) {
        return ctx.reply(`ℹ️ ${displayName} does not have any role in this project.`);
      }

      if (existingRole.role === 'mod') {
        return ctx.reply(`ℹ️ ${displayName} is already a *Moderator* (lowest admin tier).`, { parse_mode: 'Markdown' });
      }

      try {
        const targetCache = await resolveUsernameToId(displayName.replace(/^@/, ''));
        await setUserRole(
          project.id,
          targetId,
          'mod',
          senderId,
          targetCache?.username || null
        );

        return ctx.reply(
          `✅ *Demotion Complete*\n\n` +
          `${ROLE_EMOJI.mod} ${displayName} has been demoted to *Moderator* (Tier 2b) in *${project.project_name || 'this project'}*.\n\n` +
          `🔒 *Revoked:* Treasury access, airdrops, and financial operations.\n` +
          `✅ *Retained:* Trivia management, games, and chat moderation.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err: any) {
        return ctx.reply(`❌ Demotion failed: ${err.message}`);
      }
    }
  );

  // ─── /removeadmin ──────────────────────────────────────────────────────────
  // Project Owner Only: Remove all admin privileges from a user.
  // Works in both group chat and private DM.
  // Usage: /removeadmin @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['removeadmin', `removeadmin@${BOT_USERNAME}`],
    async (ctx) => {
      const senderId = ctx.from!.id;

      const { project, error: projError } = await resolveProject(ctx);
      if (!project) {
        return ctx.reply(projError || '⚠️ No project found.', { parse_mode: 'Markdown' });
      }

      const isOwner = project.owner_telegram_id === senderId;
      if (!isOwner && !isGlobalMaster(senderId)) {
        return ctx.reply('⛔ Only the *Project Owner* can remove admins.', { parse_mode: 'Markdown' });
      }

      const { telegramId: targetId, displayName, error } = await parseTargetArg(ctx);
      if (error || !targetId) {
        return ctx.reply(`❌ ${error || 'Invalid target.'}`, { parse_mode: 'Markdown' });
      }

      // SAFETY: The Project Owner can NEVER be removed
      if (targetId === project.owner_telegram_id) {
        return ctx.reply(
          '🔒 *Safety Check Failed*\n\n' +
          'The Project Owner *cannot* be removed. This is a protected immutable role.',
          { parse_mode: 'Markdown' }
        );
      }

      // Cannot remove a Global Master
      if (isGlobalMaster(targetId)) {
        return ctx.reply(
          '🔒 *Safety Check Failed*\n\n' +
          'Global Masters (Tier 0) cannot be removed by anyone.',
          { parse_mode: 'Markdown' }
        );
      }

      const existingRole = await getUserRole(project.id, targetId);
      if (!existingRole) {
        return ctx.reply(`ℹ️ ${displayName} does not have any role in this project.`);
      }

      try {
        await removeUserRole(project.id, targetId);

        return ctx.reply(
          `✅ *Admin Removed*\n\n` +
          `${displayName} has been stripped of all administrative privileges in *${project.project_name || 'this project'}*.\n` +
          `Previous role: *${ROLE_LABEL[existingRole.role]}*`,
          { parse_mode: 'Markdown' }
        );
      } catch (err: any) {
        return ctx.reply(`❌ Removal failed: ${err.message}`);
      }
    }
  );

  // ─── /roles ────────────────────────────────────────────────────────────────
  // Anyone with mod+ access: List all roles in the current project.
  // Works in both group chat and private DM.
  // Usage: /roles
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['roles', `roles@${BOT_USERNAME}`],
    async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return ctx.reply('⛔ Could not identify your user ID.');

      const { project, error: projError } = await resolveProject(ctx);
      if (!project) {
        return ctx.reply(projError || '⚠️ No project found.', { parse_mode: 'Markdown' });
      }

      // Permission check
      const hasPermission = await checkRbacPermission(project, userId, 'mod');
      if (!hasPermission) {
        return ctx.reply('⛔ You need at least *Moderator* access to view roles.', { parse_mode: 'Markdown' });
      }

      const roles = await listProjectRoles(project.id);
      if (roles.length === 0) {
        return ctx.reply('ℹ️ No roles assigned yet in this project.');
      }

      let text = `📋 *Project Roles — ${project.project_name || 'Unnamed'}*\n\n`;
      for (const r of roles) {
        const emoji = ROLE_EMOJI[r.role] || '•';
        const label = ROLE_LABEL[r.role] || r.role;
        const name = r.username ? `@${r.username}` : `ID: \`${r.telegram_id}\``;
        text += `${emoji} ${name} — *${label}*\n`;
      }

      return ctx.reply(text, { parse_mode: 'Markdown' });
    }
  );

  // ─── /myrole ───────────────────────────────────────────────────────────────
  // Anyone: Check your own role in the current project.
  // Works in both group chat and private DM.
  // Usage: /myrole
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(['myrole', `myrole@${BOT_USERNAME}`], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply('⛔ Could not identify your user ID.');

    const { project, error: projError } = await resolveProject(ctx);
    if (!project) {
      return ctx.reply(projError || '⚠️ No project found.', { parse_mode: 'Markdown' });
    }

    const role = await getEffectiveRole(project.id, userId);
    if (!role) {
      return ctx.reply(`ℹ️ You do not have an assigned role in *${project.project_name || 'this project'}*.`, { parse_mode: 'Markdown' });
    }

    return ctx.reply(
      `${ROLE_EMOJI[role]} Your role in *${project.project_name || 'this project'}*: *${ROLE_LABEL[role]}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── /rbachelp ─────────────────────────────────────────────────────────────
  // Display the RBAC admin help organized by role tier.
  // Usage: /rbachelp
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(['rbachelp', `rbachelp@${BOT_USERNAME}`], async (ctx) => {
    const helpText =
      `🏗️ *WifhPaws RBAC — Role-Based Access Control*\n\n` +
      `💡 *All admin commands work in DMs!* Just DM the bot.\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👑 *Tier 0 — Global Masters (Founders)*\n` +
      `Only the 3 hardcoded founder IDs.\n` +
      `• \`/initproject @owner [name]\` — Bootstrap a project *(group only)*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏛️ *Tier 1 — Project Owner*\n` +
      `Root authority for their project. Cannot be demoted.\n` +
      `• \`/addadmin @user\` — Add a moderator\n` +
      `• \`/promotesuper @user\` — Elevate mod → Super Admin\n` +
      `• \`/demote @user\` — Demote Super Admin → Mod\n` +
      `• \`/removeadmin @user\` — Strip all privileges\n` +
      `• \`/roles\` — View all project roles\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⭐ *Tier 2a — Super Admins*\n` +
      `Treasury, airdrops, and financial operations.\n` +
      `• \`/addadmin @user\` — Add a moderator\n` +
      `• All moderator commands\n` +
      `• Treasury & airdrop access\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🛡️ *Tier 2b — Moderators*\n` +
      `Trivia, games, and chat moderation only.\n` +
      `• 🚫 NO financial operations access\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📋 *General Commands:*\n` +
      `• \`/myrole\` — Check your current role\n` +
      `• \`/roles\` — List all project staff\n` +
      `• \`/selectproject\` — Switch active project (if in multiple)\n` +
      `• \`/rbachelp\` — This help message`;

    return ctx.reply(helpText, { parse_mode: 'Markdown' });
  });
}
