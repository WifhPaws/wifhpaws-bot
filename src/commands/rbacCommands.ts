// ============================================================================
// WifhPaws RBAC Command Handlers
// All bot commands for the three-tier white-label RBAC system.
//
// Commands implemented:
//   /initproject   — Global Masters only: bootstrap a project instance
//   /addadmin      — Project Owner / Super Admin: add a mod
//   /promotesuper  — Project Owner only: elevate a mod → super_admin
//   /demote        — Project Owner only: demote super_admin → mod
//   /removeadmin   — Project Owner only: strip all admin privileges
//   /roles         — List all roles for the current project
//   /myrole        — Show the caller's role in the current project
//   /rbachelp      — Display RBAC command help organized by tier
// ============================================================================

import { Telegraf, Context } from 'telegraf';
import {
  isGlobalMaster,
  GLOBAL_MASTER_IDS,
  getProjectByChatId,
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
} from '../services/rbacService';
import {
  globalMasterOnly,
  projectOwnerOnly,
  requireRole,
} from '../middleware/rbacGuards';
import { RbacRole, ROLE_WEIGHT } from '../types/rbac';

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
// Helper: Parse the target user argument from a command message
// ---------------------------------------------------------------------------

async function parseTargetArg(ctx: Context): Promise<{
  telegramId: number | null;
  displayName: string;
  error?: string;
}> {
  const message = ctx.message as any;
  if (!message?.text) {
    return { telegramId: null, displayName: '', error: 'No command text found.' };
  }

  const args = message.text.trim().split(/\s+/).slice(1);
  if (args.length === 0) {
    return { telegramId: null, displayName: '', error: 'Please provide a @username or numeric Telegram ID.' };
  }

  const rawArg = args[0];
  const resolved = await resolveUserArg(rawArg);
  const displayName = rawArg.startsWith('@') ? rawArg : `ID:${rawArg}`;

  if (!resolved) {
    return {
      telegramId: null,
      displayName,
      error:
        `Could not resolve \`${displayName}\` to a Telegram user ID.\n\n` +
        `💡 *Tip:* The user must first interact with the bot (e.g. send /start) so their handle can be cached.`,
    };
  }

  return { telegramId: resolved, displayName };
}

// ============================================================================
// REGISTER ALL RBAC COMMANDS ON THE BOT
// ============================================================================

export function registerRbacCommands(bot: Telegraf<Context>): void {
  const BOT_USERNAME = process.env.BOT_USERNAME || '';

  // ─── /initproject ──────────────────────────────────────────────────────────
  // Global Masters Only: Bootstrap a project instance for the current group.
  // Usage: /initproject <owner_telegram_id_or_@handle> [project_name]
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['initproject', `initproject@${BOT_USERNAME}`],
    globalMasterOnly,
    async (ctx) => {
      const senderId = ctx.from!.id;
      const chatId = ctx.chat!.id;

      if (ctx.chat!.type === 'private') {
        return ctx.reply(
          '⚠️ `/initproject` must be run inside a *group chat* to register that group as a project.',
          { parse_mode: 'Markdown' }
        );
      }

      const message = ctx.message as any;
      const args = (message?.text || '').trim().split(/\s+/).slice(1);

      if (args.length === 0) {
        return ctx.reply(
          '📋 *Usage:* `/initproject <owner_id_or_@handle> [project_name]`\n\n' +
          '*Examples:*\n' +
          '• `/initproject @clientlead`\n' +
          '• `/initproject 123456789 "Acme Project"`\n\n' +
          '🔒 Only Global Masters can run this command.',
          { parse_mode: 'Markdown' }
        );
      }

      const ownerArg = args[0];
      const projectName = args.slice(1).join(' ').replace(/"/g, '') || undefined;

      // Resolve the owner argument
      const ownerId = await resolveUserArg(ownerArg);
      if (!ownerId) {
        return ctx.reply(
          `❌ Could not resolve \`${ownerArg}\` to a Telegram user.\n\n` +
          `💡 The designated owner must first send /start to this bot so their handle is cached.`,
          { parse_mode: 'Markdown' }
        );
      }

      // Fetch owner's cached username for display
      const ownerCache = await resolveUsernameToId(ownerArg.replace(/^@/, ''));
      const ownerUsername = ownerCache?.username || null;

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
          `The Project Owner can now:\n` +
          `• \`/addadmin @user\` — Add moderators\n` +
          `• \`/promotesuper @user\` — Elevate mods to Super Admin\n` +
          `• \`/demote @user\` — Demote staff\n` +
          `• \`/removeadmin @user\` — Remove staff entirely`,
          { parse_mode: 'Markdown' }
        );
      } catch (err: any) {
        return ctx.reply(`❌ *Bootstrap Failed:* ${err.message}`, { parse_mode: 'Markdown' });
      }
    }
  );

  // ─── /addadmin ─────────────────────────────────────────────────────────────
  // Project Owner or Super Admin: Add a user as a standard Moderator (mod).
  // Usage: /addadmin @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['addadmin', `addadmin@${BOT_USERNAME}`],
    requireRole('super_admin'),
    async (ctx) => {
      const senderId = ctx.from!.id;
      const chatId = ctx.chat!.id;

      const project = await getProjectByChatId(chatId);
      if (!project) {
        return ctx.reply(
          '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject`.',
          { parse_mode: 'Markdown' }
        );
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
          `${ROLE_EMOJI.mod} ${displayName} is now a *Moderator* (Tier 2b).\n\n` +
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
  // Usage: /promotesuper @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['promotesuper', `promotesuper@${BOT_USERNAME}`],
    projectOwnerOnly,
    async (ctx) => {
      const senderId = ctx.from!.id;
      const chatId = ctx.chat!.id;

      const project = await getProjectByChatId(chatId);
      if (!project) {
        return ctx.reply(
          '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject`.',
          { parse_mode: 'Markdown' }
        );
      }

      const { telegramId: targetId, displayName, error } = await parseTargetArg(ctx);
      if (error || !targetId) {
        return ctx.reply(`❌ ${error || 'Invalid target.'}`, { parse_mode: 'Markdown' });
      }

      // Safety: Cannot promote the Project Owner (they are already above super_admin)
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
          `${ROLE_EMOJI.super_admin} ${displayName} is now a *Super Admin* (Tier 2a).\n\n` +
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
  // Usage: /demote @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['demote', `demote@${BOT_USERNAME}`],
    projectOwnerOnly,
    async (ctx) => {
      const senderId = ctx.from!.id;
      const chatId = ctx.chat!.id;

      const project = await getProjectByChatId(chatId);
      if (!project) {
        return ctx.reply(
          '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject`.',
          { parse_mode: 'Markdown' }
        );
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
          `${ROLE_EMOJI.mod} ${displayName} has been demoted to *Moderator* (Tier 2b).\n\n` +
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
  // Usage: /removeadmin @username
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['removeadmin', `removeadmin@${BOT_USERNAME}`],
    projectOwnerOnly,
    async (ctx) => {
      const senderId = ctx.from!.id;
      const chatId = ctx.chat!.id;

      const project = await getProjectByChatId(chatId);
      if (!project) {
        return ctx.reply(
          '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject`.',
          { parse_mode: 'Markdown' }
        );
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
          `${displayName} has been stripped of all administrative privileges.\n` +
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
  // Usage: /roles
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(
    ['roles', `roles@${BOT_USERNAME}`],
    requireRole('mod'),
    async (ctx) => {
      const chatId = ctx.chat!.id;
      const project = await getProjectByChatId(chatId);
      if (!project) {
        return ctx.reply(
          '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject`.',
          { parse_mode: 'Markdown' }
        );
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
  // Usage: /myrole
  // ─────────────────────────────────────────────────────────────────────────
  bot.command(['myrole', `myrole@${BOT_USERNAME}`], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply('⛔ Could not identify your user ID.');

    const chatId = ctx.chat!.id;
    const project = await getProjectByChatId(chatId);
    if (!project) {
      return ctx.reply(
        '⚠️ This group is not yet initialized. Ask a Global Master to run `/initproject`.',
        { parse_mode: 'Markdown' }
      );
    }

    const role = await getEffectiveRole(project.id, userId);
    if (!role) {
      return ctx.reply('ℹ️ You do not have an assigned role in this project.');
    }

    return ctx.reply(
      `${ROLE_EMOJI[role]} Your role: *${ROLE_LABEL[role]}*`,
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
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👑 *Tier 0 — Global Masters (Founders)*\n` +
      `Only the 3 hardcoded founder IDs.\n` +
      `• \`/initproject @owner [name]\` — Bootstrap a project\n\n` +
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
      `• \`/rbachelp\` — This help message`;

    return ctx.reply(helpText, { parse_mode: 'Markdown' });
  });
}
