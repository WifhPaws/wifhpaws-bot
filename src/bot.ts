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
  getOrCreateUser,
} from "./supabase";

/**
 * Checks if text contains any trigger keyword (case-insensitive).
 * Uses simple word-boundary detection for reliability.
 */
export function hasTriggerKeyword(text: string, keywords: string[] = TRIGGER_KEYWORDS): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    const kwLower = kw.trim().toLowerCase();
    if (!kwLower) return false;
    const idx = lower.indexOf(kwLower);
    if (idx === -1) return false;
    // Check word boundaries
    const before = idx > 0 ? lower[idx - 1] : ' ';
    const after = idx + kwLower.length < lower.length ? lower[idx + kwLower.length] : ' ';
    const boundaryChars = ' \t\n.,!?;:()\'"';
    return (boundaryChars.includes(before) || idx === 0) &&
           (boundaryChars.includes(after) || idx + kwLower.length === lower.length);
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
