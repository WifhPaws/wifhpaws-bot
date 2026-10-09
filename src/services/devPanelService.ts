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

    const renderBaseUrl = process.env.RENDER_EXTERNAL_URL || 'https://wifhpaws-bot.onrender.com';
    const hatcheryUrl = renderBaseUrl.endsWith('/') ? renderBaseUrl + 'hatchery' : renderBaseUrl + '/hatchery';

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
        Markup.button.callback('🔥 Burn ($WIFH)', 'dev_burn_menu'),
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

  // ── Buy-Back & Burn Menu ───────────────────────────────────────────────────
  bot.action('dev_burn_menu', async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🔥 *Dev Wallet – Burn $WIFH*\n\n` +
      `Ready to permanently burn WIFH tokens from the **Dev Wallet**.\n` +
      `Tokens will be sent to the dead address: \`0x000000000000000000000000000000000000dead\`\n\n` +
      `Select an amount to burn, or use \`/dburn [amount]\` for a custom amount:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('25%', 'dev_burn_pct_25'),
            Markup.button.callback('50%', 'dev_burn_pct_50'),
            Markup.button.callback('100%', 'dev_burn_pct_100'),
          ],
          [Markup.button.callback('« Back to Dev Panel', 'dev_back')],
        ]),
      }
    );
  });

  bot.action(/^dev_burn_pct_(25|50|100)$/, async (ctx) => {
    if (!await isAuthorizedAdmin(ctx.from?.id)) return ctx.answerCbQuery('⛔ Unauthorized');
    if (!deps.devSigner) {
      await ctx.answerCbQuery('❌ Dev Wallet private key is not configured.', { show_alert: true });
      return;
    }

    const pct = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery(`Initiating ${pct}% burn...`);
    
    try {
      // 1. Gas Pre-Check Validation
      const ethBalanceWei = await deps.provider.getBalance(deps.devSigner.address);
      if (ethBalanceWei === 0n) { // strict 0.0000 ETH check or insufficient check
        await ctx.reply('❌ Insufficient native ETH gas in Dev Wallet to process transaction. Please top up gas before burning tokens.');
        return;
      }

      if (!deps.wifhContractAddress) {
        await ctx.reply('❌ WIFH contract address is not configured.');
        return;
      }

      const contract = new ethers.Contract(deps.wifhContractAddress, deps.erc20Abi, deps.devSigner);
      const balanceWei = await contract.balanceOf(deps.devSigner.address);
      
      if (balanceWei === 0n) {
        await ctx.reply('❌ No WIFH tokens available in Dev Wallet to burn.');
        return;
      }

      const burnAmountWei = (balanceWei * BigInt(pct)) / 100n;
      const decimals = await contract.decimals();
      const burnAmountFmt = ethers.formatUnits(burnAmountWei, decimals);
      
      const statusMsg = await ctx.reply(`⏳ Processing ${pct}% Dev Wallet burn (${burnAmountFmt} WIFH) on Robinhood Chain...`);
      
      const deadAddress = '0x000000000000000000000000000000000000dead';
      
      // Execute the transfer (burn)
      const tx = await contract.transfer(deadAddress, burnAmountWei, { gasLimit: 150000n });
      await tx.wait();
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        undefined,
        `✅ *Burn Successful!*\n\n🔥 Permanently removed \`${burnAmountFmt} WIFH\` from circulation.\n\n🔗 *Tx Hash:*\n\`${tx.hash}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      console.error('[DevPanel] Burn error:', err);
      // Fallback gas check if it failed due to insufficient funds for intrinsic tx
      if (err.message?.includes('insufficient funds for intrinsic transaction cost')) {
        await ctx.reply('❌ Insufficient native ETH gas in Dev Wallet to process transaction. Please top up gas before burning tokens.');
      } else {
        await ctx.reply(`❌ Burn transaction failed: ${err.shortMessage || err.message}`);
      }
    }
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


}
