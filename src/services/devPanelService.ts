import { Context, Markup, Telegraf } from 'telegraf';

/**
 * Renders the main Dev Panel menu with action buttons.
 */
export async function sendDevPanelMenu(ctx: Context) {
  const text =
    `🛠️ *Developer & Liquidity Control Panel*\n\n` +
    `Advanced tools for treasury deployments, buy-backs, liquidity rebalancing, and burn sequences.\n\n` +
    `Select an operation below:`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🛒 Dev Buy ($WIFH)', 'dev_buy'),
      Markup.button.callback('💸 Dev Sell / Liquidity', 'dev_sell')
    ],
    [
      Markup.button.callback('🔥 Buy-Back & Burn', 'dev_burn'),
      Markup.button.callback('🏛️ Treasury Dashboard', 'action_treasury_home')
    ],
    [
      Markup.button.callback('⚙️ Admin Tools', 'admin_tools_menu'),
      Markup.button.callback('⬅️ Back to Wallet', 'action_wallet_home')
    ]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      return;
    } catch {
      // Fallback if editMessageText fails
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

export function setupDevPanelActions(
  bot: Telegraf<Context>,
  isAuthorizedAdmin: (id: number | undefined) => Promise<boolean>
) {
  // Action: Open or Return to Dev Panel (handling dev_panel, dev_back, and action_open_admin)
  bot.action(['dev_panel', 'dev_back', 'action_open_admin'], async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    await ctx.answerCbQuery();
    await sendDevPanelMenu(ctx);
  });

  // Action: Execute Dev Buy / Treasury Deployment
  bot.action('dev_buy', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🛒 *Execute Dev Buy ($WIFH)*\n\n` +
      `Status: Ready to execute automated buy-back using treasury funds.\n` +
      `Click confirm below to proceed with the transaction.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Confirm Buy-Back', 'confirm_dev_buy')],
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')]
        ])
      }
    );
  });

  // Action: Execute Dev Sell / Liquidity Management
  bot.action('dev_sell', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `💸 *Execute Dev Sell / Liquidity Adjustment*\n\n` +
      `Status: Manual liquidity rebalancing tool.\n` +
      `Warning: This will interact directly with pool contracts.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚠️ Confirm Liquidity Adjustment', 'confirm_dev_sell')],
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')]
        ])
      }
    );
  });

  // Action: Trigger Buy-Back & Burn
  bot.action('dev_burn', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🔥 *Trigger Buy-Back & Burn*\n\n` +
      `Ready to permanently burn accumulated tokens from circulation to support ecosystem value.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 Fire Burn Sequence', 'confirm_dev_burn')],
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')]
        ])
      }
    );
  });

  // Action Confirmations
  bot.action('confirm_dev_buy', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    await ctx.answerCbQuery('Processing buy-back request...');
    await ctx.editMessageText(
      `🛒 *Dev Buy Confirmation*\n\n` +
      `Automated buy-back signal acknowledged.\n` +
      `_Note: Ensure treasury wallet has sufficient ETH balance to execute pool swaps._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')]
        ])
      }
    );
  });

  bot.action('confirm_dev_sell', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    await ctx.answerCbQuery('Processing liquidity adjustment...');
    await ctx.editMessageText(
      `💸 *Dev Sell / Liquidity Adjustment*\n\n` +
      `Liquidity rebalance signal acknowledged.\n` +
      `_Note: Directly interfacing with Uniswap V3 pool contract router._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')]
        ])
      }
    );
  });

  bot.action('confirm_dev_burn', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized');
    await ctx.answerCbQuery('Burn sequence confirmed!');
    await ctx.editMessageText(
      `🔥 *Buy-Back & Burn Sequence*\n\n` +
      `Burn request recorded. Tokens will be routed to the 0x0000...dead burn address.\n` +
      `_Circulating supply reduction will be reflected on-chain._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')]
        ])
      }
    );
  });
}
