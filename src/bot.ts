import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import {
  TRIGGER_KEYWORDS,
  POINTS_PER_TRIGGER,
  COOLDOWN_MINUTES,
  loadConfig,
  formatRewardMessage,
} from "./config";
import {
  awardKeywordPoints,
  getLeaderboard,
  airdropPointsByHandle,
  getOrCreateUser,
} from "./supabase";

/**
 * Escapes special regex characters in keywords
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks if text contains any of the trigger keywords with word boundaries (case-insensitive)
 */
export function hasTriggerKeyword(text: string, keywords: string[] = TRIGGER_KEYWORDS): boolean {
  if (!text) return false;
  return keywords.some((kw) => {
    const escaped = escapeRegex(kw.trim());
    // Use word boundaries so that "gm" doesn't match inside "segment", etc.
    const regex = new RegExp(`(^|\\s|[.,!?;:()""''])${escaped}([.,!?;:()""'']|\\s|$)`, "i");
    return regex.test(text);
  });
}

/**
 * Initializes and configures the Telegraf bot instance.
 */
export function createBot(): Telegraf {
  const config = loadConfig();

  if (!config.botToken) {
    throw new Error("BOT_TOKEN is not defined in environment variables or .env file.");
  }

  const bot = new Telegraf(config.botToken);

  // ----------------------------------------------------------------------------
  // Command: /start & /help
  // ----------------------------------------------------------------------------
  bot.command(["start", "help"], async (ctx) => {
    const welcomeText =
      `🐾 *Welcome to WifhPaws!* 🐾\n\n` +
      `Spread good vibes in the group and earn *Paw Points*!\n\n` +
      `*How it works:*\n` +
      `• Say friendly words like \`gm\`, \`thanks\`, \`ty\`, \`lfg\` in group chats.\n` +
      `• Earn *${POINTS_PER_TRIGGER} points* per trigger (cooldown: ${COOLDOWN_MINUTES} min).\n\n` +
      `*Available Commands:*\n` +
      `• /leaderboard - View the top 10 Paw Point holders\n` +
      `• /mypoints - Check your current Paw Points\n` +
      `• /setwallet <address> - Link your crypto wallet for future rewards\n` +
      `• /airdrop @handle <amount> - (Admin only) Airdrop bonus points`;

    await ctx.reply(welcomeText, { parse_mode: "Markdown" });
  });

  // ----------------------------------------------------------------------------
  // Command: /mypoints
  // ----------------------------------------------------------------------------
  bot.command(["mypoints", "points", "me"], async (ctx) => {
    if (!ctx.from) return;

    try {
      const user = await getOrCreateUser(
        ctx.from.id,
        ctx.from.username || ctx.from.first_name || "Anonymous"
      );

      const points = user ? user.points : 0;
      const wallet = user?.wallet_address ? `\`${user.wallet_address}\`` : "_Not set_ (use /setwallet)";

      await ctx.reply(
        `🐾 *Paw Stats for ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}:*\n` +
        `• *Points:* ${points} 🦴\n` +
        `• *Wallet:* ${wallet}`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      console.error("[Command: /mypoints] Error:", err.message);
      await ctx.reply("❌ Could not retrieve your points. Please try again later.");
    }
  });

  // ----------------------------------------------------------------------------
  // Command: /leaderboard
  // ----------------------------------------------------------------------------
  bot.command("leaderboard", async (ctx) => {
    try {
      const topUsers = await getLeaderboard(10);

      if (!topUsers || topUsers.length === 0) {
        await ctx.reply("🐾 No Paw Points have been awarded yet. Start chatting to get on the board!");
        return;
      }

      const medals = ["🥇", "🥈", "🥉"];
      let text = "🏆 *WifhPaws Top 10 Leaderboard* 🐾\n\n";

      topUsers.forEach((user, index) => {
        const rankBadge = medals[index] || `*${index + 1}.*`;
        const displayName = user.username ? `@${user.username}` : `User #${user.telegram_id}`;
        text += `${rankBadge} ${displayName} — *${user.points}* pts\n`;
      });

      text += `\nKeep active and spread positive vibes to climb the ranks! 🚀`;

      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (err: any) {
      console.error("[Command: /leaderboard] Error:", err.message);
      await ctx.reply("❌ Failed to fetch leaderboard. Please try again later.");
    }
  });

  // ----------------------------------------------------------------------------
  // Command: /airdrop @handle <amount> (Admin Only)
  // ----------------------------------------------------------------------------
  bot.command("airdrop", async (ctx) => {
    const senderId = ctx.from?.id;
    if (!senderId) return;

    // Check admin authorization
    if (!config.adminUserIds.includes(senderId)) {
      await ctx.reply("⛔ Unauthorized: This command is restricted to administrators.", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    // Parse arguments: /airdrop @username 100
    const rawArgs = ctx.message.text.trim().split(/\s+/).slice(1);

    if (rawArgs.length < 2) {
      await ctx.reply(
        "ℹ️ *Usage:* `/airdrop @handle <amount>`\n*Example:* `/airdrop @wifpaws_fan 500`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const targetHandle = rawArgs[0];
    const amount = parseInt(rawArgs[1], 10);

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply("❌ Amount must be a positive integer.");
      return;
    }

    try {
      const result = await airdropPointsByHandle(targetHandle, amount);

      if (!result.success) {
        await ctx.reply(`⚠️ ${result.error}`);
        return;
      }

      const awardedUser = result.user!;
      const displayHandle = awardedUser.username ? `@${awardedUser.username}` : `@${targetHandle.replace(/^@/, "")}`;

      await ctx.reply(
        `🎉 *Airdrop Successful!* 🐾\n\n` +
        `• Recipient: ${displayHandle}\n` +
        `• Airdropped: *+${amount}* Paw Points\n` +
        `• New Total Balance: *${awardedUser.points}* pts`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      console.error("[Command: /airdrop] Error:", err.message);
      await ctx.reply("❌ Error executing airdrop. Please check logs.");
    }
  });

  // ----------------------------------------------------------------------------
  // Group Keyword Listener
  // ----------------------------------------------------------------------------
  bot.on(message("text"), async (ctx, next) => {
    const chatType = ctx.chat.type;

    // Only process group and supergroup chats
    if (chatType !== "group" && chatType !== "supergroup") {
      return next();
    }

    // Ignore bot messages
    if (ctx.from?.is_bot) {
      return next();
    }

    const messageText = ctx.message.text;
    const fromUser = ctx.from;
    if (!fromUser || !messageText) {
      return next();
    }

    // Ignore commands (starts with /)
    if (messageText.startsWith("/")) {
      return next();
    }

    // Check if message matches any TRIGGER_KEYWORDS
    if (!hasTriggerKeyword(messageText, TRIGGER_KEYWORDS)) {
      return next();
    }

    const usernameOrName = fromUser.username || fromUser.first_name || "Fren";

    try {
      // Award points with cooldown enforcement
      const result = await awardKeywordPoints(
        fromUser.id,
        fromUser.username || null,
        POINTS_PER_TRIGGER,
        COOLDOWN_MINUTES
      );

      if (result.awarded) {
        const replyText = formatRewardMessage(usernameOrName, POINTS_PER_TRIGGER);
        await ctx.reply(replyText, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      } else if (result.reason === "cooldown") {
        // Cooldown active: deliberately do not spam chat, silently ignore
      }
    } catch (err: any) {
      console.error("[Group Listener] Error processing reward:", err.message);
    }

    return next();
  });

  // Error handling
  bot.catch((err: any, ctx: Context) => {
    console.error(`[Telegraf Error] in update ${ctx.update.update_id}:`, err);
  });

  return bot;
}
