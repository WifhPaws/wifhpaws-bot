import { ethers } from 'ethers';
import { Context, Markup, Telegraf } from 'telegraf';
import { getDevWalletAddress } from './feeService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DevPanelDeps {
  provider: ethers.JsonRpcProvider;
  wifhContractAddress: string;
  erc20Abi: string[];
  /** Optional signer for the Dev Wallet (enables Send / Swap actions). */
  devSigner?: ethers.Wallet | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BACK_TO_DEV = [[Markup.button.callback('« Back to Dev Panel', 'dev_back')]];

async function fetchDevWalletBalances(
  deps: DevPanelDeps
): Promise<{ address: string; ethBalance: string; wifhBalance: string }> {
  const address = deps.devSigner?.address || getDevWalletAddress();

  let ethBalance = '0.0000';
  let wifhBalance = '0.00';

  if (!address) return { address: '(not configured)', ethBalance, wifhBalance };

  try {
    const wei = await deps.provider.getBalance(address);
    ethBalance = parseFloat(ethers.formatEther(wei)).toFixed(4);
  } catch (e: any) {
    console.warn('[DevPanel] ETH balance fetch failed:', e?.message);
  }

  if (deps.wifhContractAddress) {
    try {
      const contract = new ethers.Contract(
        deps.wifhContractAddress,
        deps.erc20Abi,
        deps.provider
      );
      const raw = await contract.balanceOf(address);
      const decimals = await contract.decimals();
      wifhBalance = parseFloat(ethers.formatUnits(raw, decimals)).toFixed(2);
    } catch {
      wifhBalance = '0.00';
    }
  }

  return { address, ethBalance, wifhBalance };
}

// ─── Main Dev Panel Menu ──────────────────────────────────────────────────────

/**
 * Renders the Dev Wallet dashboard with live balances and action buttons.
 */
export async function sendDevPanelMenu(ctx: Context, deps: DevPanelDeps) {
  try {
    const { address, ethBalance, wifhBalance } = await fetchDevWalletBalances(deps);
    const isConfigured = address !== '(not configured)';

    const text =
      `🛠️ *Dev Wallet Dashboard*\n\n` +
      `📍 *Address:*\n\`${address}\`\n\n` +
      `💰 *Balances (Robinhood Chain):*\n` +
      `• *ETH (Gas):* \`${ethBalance} ETH\`\n` +
      `• *WIFH Token:* \`${wifhBalance} WIFH\`\n\n` +
      `_All collected fees and revenue streams route here._\n\n` +
      `Select an operation below:`;

    const webAppUrl = process.env.WEBAPP_URL || 'https://wifhpaws.github.io/wifhpaws-bot/';
    const hatcheryUrl = webAppUrl.endsWith('/') ? webAppUrl + 'hatchery.html' : webAppUrl + '/hatchery.html';

    const keyboard = Markup.inlineKeyboard([
      [
        { text: '🧬 WifhPaws Hatchery', web_app: { url: hatcheryUrl } } as any
      ],
      [
        Markup.button.callback('📥 Receive', 'dev_receive'),
        Markup.button.callback('💸 Send', 'dev_send_guide'),
      ],
      [
        Markup.button.callback('🛒 Buy ($WIFH)', 'dev_buy'),
        Markup.button.callback('📈 Sell ($WIFH)', 'dev_swap_guide'),
      ],
      [
        Markup.button.callback('🔄 Refresh', 'dev_panel'),
        Markup.button.callback('⬅️ Close', 'action_wallet_home'),
      ],
    ]);

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
        return;
      } catch {
        // Fallback if message content unchanged or too old to edit
      }
    }
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (err: any) {
    console.error('[DevPanel] sendDevPanelMenu error:', err?.message || err);
    await ctx.reply('❌ Failed to load Dev Wallet dashboard. Please try again.');
  }
}

// ─── Action Handlers ──────────────────────────────────────────────────────────

export function setupDevPanelActions(
  bot: Telegraf<Context>,
  isAuthorizedAdmin: (id: number | undefined) => Promise<boolean>,
  deps: DevPanelDeps
) {
  // ── Open / Return to Dev Panel ──────────────────────────────────────────────
  bot.action(['dev_panel', 'dev_back'], async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();
    await sendDevPanelMenu(ctx, deps);
  });

  // ── Receive: show Dev Wallet deposit address ────────────────────────────────
  bot.action('dev_receive', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();

    const address = deps.devSigner?.address || getDevWalletAddress();
    await ctx.editMessageText(
      `📥 *Dev Wallet – Receive Funds*\n\n` +
      `Send ETH or WIFH on *Robinhood Chain* to:\n\n` +
      `\`${address || 'Address not configured'}\`\n\n` +
      `_All fees and revenue streams accumulate here automatically._`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_DEV } }
    );
  });

  // ── Send guide ─────────────────────────────────────────────────────────────
  bot.action('dev_send_guide', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `💸 *Dev Wallet – Send Funds*\n\n` +
      `Use the \`/dsend\` command in private chat (Admins only):\n\n` +
      `• *To External Wallet:*\n\`/dsend [amount] [eth/wifh] [0xAddress]\`\n\n` +
      `• *To Telegram User:*\n\`/dsend [amount] [eth/wifh] [@username]\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_DEV } }
    );
  });

  // ── Swap guide ─────────────────────────────────────────────────────────────
  bot.action('dev_swap_guide', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🔄 *Dev Wallet – Swap Tokens*\n\n` +
      `Use the \`/dswap\` command in private chat (Admins only):\n\n` +
      `• *Swap WIFH → ETH:*\n\`/dswap [amount] wifh eth\`\n\n` +
      `• *Swap ETH → WIFH:*\n\`/dswap [amount] eth wifh\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_DEV } }
    );
  });

  // ── Accumulate: earnings overview ──────────────────────────────────────────
  bot.action('dev_accumulate', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();

    try {
      const { address, ethBalance, wifhBalance } = await fetchDevWalletBalances(deps);
      await ctx.editMessageText(
        `📊 *Dev Wallet – Accumulated Fees*\n\n` +
        `📍 *Address:* \`${address}\`\n\n` +
        `💰 *Current Holdings:*\n` +
        `• ETH: \`${ethBalance} ETH\`\n` +
        `• WIFH: \`${wifhBalance} WIFH\`\n\n` +
        `_This wallet receives 1% of all WIFH transfer fees, swap revenue, and other dev income streams._`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_DEV } }
      );
    } catch (err: any) {
      await ctx.reply('❌ Failed to load accumulation data.');
    }
  });

  // ── Dev Buy ────────────────────────────────────────────────────────────────
  bot.action('dev_buy', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🛒 *Dev Wallet Buy ($WIFH)*\n\n` +
      `Ready to execute a buy-back using **Dev Wallet** funds.\n` +
      `Use \`/dswap [amount] eth wifh\` to execute.\n\n` +
      `_This does NOT use Treasury funds._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Confirm Buy-Back', 'confirm_dev_buy')],
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')],
        ]),
      }
    );
  });

  // ── Buy-Back & Burn ────────────────────────────────────────────────────────
  bot.action('dev_burn', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🔥 *Dev Wallet – Buy-Back & Burn*\n\n` +
      `Ready to permanently burn accumulated WIFH tokens from the **Dev Wallet**.\n` +
      `Tokens will be routed to the \`0x000...dead\` burn address.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 Fire Burn Sequence', 'confirm_dev_burn')],
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')],
        ]),
      }
    );
  });

  // ── Confirmations ──────────────────────────────────────────────────────────
  bot.action('confirm_dev_buy', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery('Processing buy-back request...');
    await ctx.editMessageText(
      `🛒 *Dev Buy Acknowledged*\n\n` +
      `Buy-back signal recorded. Use \`/dswap [amount] eth wifh\` to execute on-chain.\n` +
      `_Ensure the Dev Wallet has sufficient ETH balance for gas and the swap amount._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')],
        ]),
      }
    );
  });

  bot.action('confirm_dev_burn', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery('Burn sequence confirmed!');
    await ctx.editMessageText(
      `🔥 *Buy-Back & Burn Sequence*\n\n` +
      `Burn request recorded. Use \`/dsend [amount] wifh 0x000000000000000000000000000000000000dead\` to execute.\n` +
      `_Circulating supply reduction will be reflected on-chain after the transaction confirms._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')],
        ]),
      }
    );
  });
}
