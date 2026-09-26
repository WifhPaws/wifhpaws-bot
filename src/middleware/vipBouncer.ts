import { Context, MiddlewareFn } from 'telegraf';

/**
 * Hard‑coded list of Telegram user IDs that are allowed to execute admin commands.
 * You can also set this via the environment variable ADMIN_TELEGRAM_IDS as a
 * comma‑separated list.
 */
export const ADMIN_TELEGRAM_IDS: ReadonlyArray<number> = Object.freeze(
  (process.env.ADMIN_TELEGRAM_IDS?.split(',')?.map(v => Number(v.trim())) ?? [])
);

/**
 * Middleware that blocks any request whose `ctx.from.id` is not in the
 * `ADMIN_TELEGRAM_IDS` list.
 *
 * Usage:
 *   bot.command('starttrivia', adminOnly, startTriviaHandler);
 */
export const adminOnly: MiddlewareFn<Context> = async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id || !ADMIN_TELEGRAM_IDS.includes(id)) {
    await ctx.reply('⛔️ You are not authorized to run this command.');
    return;
  }
  return next();
};
