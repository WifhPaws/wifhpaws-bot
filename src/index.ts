import http from 'http';
import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// ==========================================
// ENVIRONMENT VARIABLES & VALIDATION
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim();
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const WALLET_ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY?.trim();
const WIFH_CONTRACT_ADDRESS = process.env.WIFH_CONTRACT_ADDRESS?.trim() || '';
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com';

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY || !WALLET_ENCRYPTION_KEY) {
  throw new Error(
    'Missing required environment variables in .env (ensure BOT_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY, and WALLET_ENCRYPTION_KEY are set).'
  );
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL);

// ERC-20 Minimal ABI for balance checking
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (boolean)',
];

const COOLDOWN_SECONDS = 900; // 15 minutes (900 seconds)

// ==========================================
// CRYPTO ENCRYPTION HELPERS (AES-256-GCM)
// ==========================================
function encryptPrivateKey(privateKey: string): string {
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(WALLET_ENCRYPTION_KEY!, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptPrivateKey(encryptedData: string): string {
  const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');
  if (!ivHex || !authTagHex || !encryptedText) {
    throw new Error('Corrupted or invalid encrypted wallet data.');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = crypto.scryptSync(WALLET_ENCRYPTION_KEY!, 'salt', 32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ==========================================
// WALLET MANAGEMENT FUNCTIONS
// ==========================================
async function getOrCreateWallet(telegramId: number): Promise<{ public_address: string; encrypted_private_key: string }> {
  // 1. Check if wallet exists
  const { data: existingWallet, error: fetchError } = await supabase
    .from('user_wallets')
    .select('public_address, encrypted_private_key')
    .eq('telegram_id', telegramId)
    .single();

  if (existingWallet && !fetchError) {
    return existingWallet;
  }

  // 2. Generate new EVM Wallet
  const newWallet = ethers.Wallet.createRandom();
  const encryptedKey = encryptPrivateKey(newWallet.privateKey);

  const { data: createdWallet, error } = await supabase
    .from('user_wallets')
    .insert({
      telegram_id: telegramId,
      public_address: newWallet.address,
      encrypted_private_key: encryptedKey,
    })
    .select('public_address, encrypted_private_key')
    .single();

  if (error || !createdWallet) {
    throw new Error(`Failed to create wallet: ${error?.message || 'Database error'}`);
  }

  // Also update wallet_address in users table for convenience
  await supabase
    .from('users')
    .update({ wallet_address: newWallet.address })
    .eq('telegram_id', telegramId);

  return createdWallet;
}

// Helper: Check if user is Admin
function isAdmin(userId: number): boolean {
  return ADMIN_USER_IDS.includes(userId.toString());
}

// Helper: Extract Target User ID or Mention
async function getTargetUser(ctx: Context): Promise<{ id: number; username?: string } | null> {
  const msg = ctx.message as any;
  if (!msg || !msg.text) return null;

  if (msg.reply_to_message?.from) {
    return {
      id: msg.reply_to_message.from.id,
      username: msg.reply_to_message.from.username,
    };
  }

  const args = msg.text.trim().split(/\s+/).slice(1);
  if (args.length > 0) {
    const target = args[0].replace(/^@/, '');
    if (!isNaN(Number(target))) {
      return { id: Number(target) };
    }

    const { data } = await supabase
      .from('users')
      .select('telegram_id, username')
      .ilike('username', target)
      .single();

    if (data) {
      return { id: data.telegram_id, username: data.username };
    }
  }

  return null;
}

/** Word-boundary regex matching for keywords */
function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|\\s|[.,!?;:()""''])${escaped}([.,!?;:()""'']|\\s|$)`, 'i');
  return regex.test(text);
}

// ==========================================
// PRIVATE WALLET COMMANDS
// ==========================================

bot.command('wallet', async (ctx) => {
  const isPrivate = ctx.chat.type === 'private';

  // If called in a public group chat, redirect user to DM for privacy
  if (!isPrivate) {
    const botInfo = await ctx.telegram.getMe();
    return ctx.reply(
      '🔒 For your privacy and security, wallet details are managed in private messages.',
      Markup.inlineKeyboard([
        Markup.button.url('📩 Open Private Wallet', `https://t.me/${botInfo.username}?start=wallet`),
      ])
    );
  }

  const telegramId = ctx.from.id;

  try {
    const wallet = await getOrCreateWallet(telegramId);

    // Fetch ETH Gas Balance (Robinhood Chain)
    let ethBalance = '0.0000';
    try {
      const ethBalanceWei = await provider.getBalance(wallet.public_address);
      ethBalance = parseFloat(ethers.formatEther(ethBalanceWei)).toFixed(4);
    } catch (e: any) {
      console.warn('[Wallet] RPC error fetching balance:', e.message);
    }

    // Fetch WIFH Token Balance
    let wifhBalance = '0.0';
    if (WIFH_CONTRACT_ADDRESS) {
      try {
        const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
        const rawBalance = await tokenContract.balanceOf(wallet.public_address);
        const decimals = await tokenContract.decimals();
        wifhBalance = ethers.formatUnits(rawBalance, decimals);
      } catch (e: any) {
        wifhBalance = 'Error reading contract';
      }
    }

    const messageText =
      `🐾 *Your WifhPaws Wallet*\n\n` +
      `📍 *Address:* \`${wallet.public_address}\`\n\n` +
      `💰 *Balances (Robinhood Chain):*\n` +
      `• *ETH (Gas):* \`${ethBalance} ETH\`\n` +
      `• *WIFH Token:* \`${wifhBalance}\`\n\n` +
      `🔑 Type \`/export\` here in private to view your private key.\n` +
      `⚠️ _Never share your private key with anyone._`;

    return ctx.reply(messageText, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('[Wallet Command] Error:', err);
    return ctx.reply(`❌ Error accessing wallet: ${err.message}`);
  }
});

// Private Key Export Command
bot.command('export', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🔒 Private key export can only be requested inside a private DM with the bot.');
  }

  const telegramId = ctx.from.id;

  try {
    const { data: wallet } = await supabase
      .from('user_wallets')
      .select('encrypted_private_key')
      .eq('telegram_id', telegramId)
      .single();

    if (!wallet) {
      return ctx.reply('❌ No wallet found. Type `/wallet` first to generate your wallet.', { parse_mode: 'Markdown' });
    }

    const privateKey = decryptPrivateKey(wallet.encrypted_private_key);

    return ctx.reply(
      `⚠️ *CONFIDENTIAL PRIVATE KEY*\n\n` +
      `Do not share this key with anyone! Anyone with this key has full control of your funds.\n\n` +
      `🔑 \`${privateKey}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Error decrypting key: ${err.message}`);
  }
});

// ==========================================
// PUBLIC & ADMIN COMMANDS
// ==========================================

bot.command('start', async (ctx) => {
  const text = (ctx.message as any)?.text || '';
  const args = text.split(/\s+/)[1];

  if (args === 'wallet' && ctx.chat.type === 'private') {
    // Auto-trigger wallet if redirected from group chat
    try {
      const wallet = await getOrCreateWallet(ctx.from.id);
      return ctx.reply(
        `🐾 *Your WifhPaws Wallet is Ready!*\n\n` +
        `📍 *Address:* \`${wallet.public_address}\`\n\n` +
        `Type \`/wallet\` to check balances, or \`/export\` to view your private key.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e: any) {
      return ctx.reply(`❌ Error setting up wallet: ${e.message}`);
    }
  }

  const welcome =
    `🐾 *Welcome to WifhPaws Bot!* 🐾\n\n` +
    `• Chat in groups to earn *Paw Points* (e.g. "gm", "thanks", "lfg")!\n` +
    `• /wallet - View your anonymous crypto wallet & address\n` +
    `• /leaderboard - View top 10 point holders\n` +
    `• /keywords - View active rewarded words`;

  return ctx.reply(welcome, { parse_mode: 'Markdown' });
});

bot.command('leaderboard', async (ctx) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('username, telegram_id, paw_points, points')
    .order('paw_points', { ascending: false })
    .limit(10);

  if (error || !users || users.length === 0) {
    return ctx.reply('🏆 No leaderboard data available yet.');
  }

  const medals = ['🥇', '🥈', '🥉'];
  let text = '🏆 *WifhPaws Top 10 Leaderboard* 🐾\n\n';

  users.forEach((user, index) => {
    const badge = medals[index] || `${index + 1}.`;
    const name = user.username ? `@${user.username}` : `User #${user.telegram_id}`;
    const pts = user.paw_points ?? user.points ?? 0;
    text += `${badge} ${name} — *${pts}* pts\n`;
  });

  return ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('addpoints', async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) {
    return ctx.reply('⛔ Unauthorized: This command is restricted to administrators.');
  }

  const text = (ctx.message as any)?.text || '';
  const args = text.trim().split(/\s+/).filter(Boolean);
  const amount = parseInt(args[args.length - 1], 10);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('⚠️ Usage: `/addpoints [amount]` (replying to user) or `/addpoints @username [amount]`', {
      parse_mode: 'Markdown',
    });
  }

  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('❌ User not found.');

  const { data: user } = await supabase
    .from('users')
    .select('paw_points, points')
    .eq('telegram_id', targetUser.id)
    .single();

  const currentPoints = user?.paw_points ?? user?.points ?? 0;
  const newBalance = currentPoints + amount;

  await supabase.from('users').upsert(
    {
      telegram_id: targetUser.id,
      username: targetUser.username || null,
      paw_points: newBalance,
      points: newBalance,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_id' }
  );

  const display = targetUser.username ? `@${targetUser.username}` : `User #${targetUser.id}`;
  return ctx.reply(`🎉 Added *${amount}* Paw Points to ${display}! New Balance: *${newBalance}* pts`, {
    parse_mode: 'Markdown',
  });
});

bot.command('resetpoints', async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) {
    return ctx.reply('⛔ Unauthorized.');
  }

  const targetUser = await getTargetUser(ctx);
  if (!targetUser) {
    return ctx.reply('⚠️ Usage: `/resetpoints @username` or reply to a user with `/resetpoints`');
  }

  await supabase.from('users').upsert(
    {
      telegram_id: targetUser.id,
      username: targetUser.username || null,
      paw_points: 0,
      points: 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_id' }
  );

  const display = targetUser.username ? `@${targetUser.username}` : `User #${targetUser.id}`;
  return ctx.reply(`🔄 Reset Paw Points to 0 for ${display}.`);
});

bot.command('addkeyword', async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) {
    return ctx.reply('⛔ Unauthorized.');
  }

  const text = (ctx.message as any)?.text || '';
  const args = text.trim().split(/\s+/).slice(1);
  if (args.length < 2) {
    return ctx.reply('⚠️ Usage: `/addkeyword [word] [points]`\nExample: `/addkeyword wagmi 15`', {
      parse_mode: 'Markdown',
    });
  }

  const keyword = args[0].toLowerCase().trim();
  const points = parseInt(args[1], 10);

  if (isNaN(points) || points <= 0) {
    return ctx.reply('❌ Points must be a positive number.');
  }

  const { error } = await supabase
    .from('dynamic_keywords')
    .upsert({ keyword, points_reward: points }, { onConflict: 'keyword' });

  if (error) return ctx.reply(`❌ Failed to add keyword: ${error.message}`);

  return ctx.reply(`✅ Keyword \`${keyword}\` successfully set to reward *${points}* Paw Points!`, {
    parse_mode: 'Markdown',
  });
});

bot.command('removekeyword', async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) {
    return ctx.reply('⛔ Unauthorized.');
  }

  const text = (ctx.message as any)?.text || '';
  const args = text.trim().split(/\s+/).slice(1);
  if (args.length < 1) {
    return ctx.reply('⚠️ Usage: `/removekeyword [word]`', { parse_mode: 'Markdown' });
  }

  const keyword = args[0].toLowerCase().trim();

  const { error } = await supabase.from('dynamic_keywords').delete().eq('keyword', keyword);
  if (error) return ctx.reply(`❌ Failed to delete keyword: ${error.message}`);

  return ctx.reply(`🗑️ Keyword \`${keyword}\` removed.`, { parse_mode: 'Markdown' });
});

bot.command('keywords', async (ctx) => {
  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');

  if (!keywords || keywords.length === 0) {
    return ctx.reply('ℹ️ No custom rewarded keywords registered.');
  }

  let text = '🔑 *Active Rewarded Keywords:*\n\n';
  keywords.forEach((k) => {
    text += `• \`${k.keyword}\`: +*${k.points_reward}* Paw Points\n`;
  });

  return ctx.reply(text, { parse_mode: 'Markdown' });
});

// ==========================================
// CHAT LISTENER (COOLDOWN & POINT REWARDS)
// ==========================================
bot.on(message('text'), async (ctx, next) => {
  const msgText = ctx.message.text;
  if (!msgText || msgText.startsWith('/') || ctx.from?.is_bot) {
    return next();
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const displayName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'fren';

  // Fetch dynamic keywords from Supabase
  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');
  if (!keywords || keywords.length === 0) return next();

  // Find if message matches any active keyword with word boundaries
  const matchedKeyword = keywords.find((k) => matchesKeyword(msgText, k.keyword));
  if (!matchedKeyword) return next();

  const { data: user } = await supabase
    .from('users')
    .select('paw_points, points, last_awarded_at')
    .eq('telegram_id', userId)
    .single();

  const now = new Date();
  if (user?.last_awarded_at) {
    const lastAwarded = new Date(user.last_awarded_at);
    const diffInSeconds = (now.getTime() - lastAwarded.getTime()) / 1000;

    if (diffInSeconds < COOLDOWN_SECONDS) {
      // Cooldown active, silently skip to avoid spam
      return next();
    }
  }

  const currentPoints = user?.paw_points ?? user?.points ?? 0;
  const newBalance = currentPoints + matchedKeyword.points_reward;

  await supabase.from('users').upsert(
    {
      telegram_id: userId,
      username: username,
      paw_points: newBalance,
      points: newBalance,
      last_awarded_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: 'telegram_id' }
  );

  await ctx.reply(
    `🐾 +${matchedKeyword.points_reward} Paw Points awarded to ${displayName} for "${matchedKeyword.keyword}"! Total: ${newBalance} pts`,
    { reply_parameters: { message_id: ctx.message.message_id } }
  );

  return next();
});

// ==========================================
// LIGHTWEIGHT HTTP SERVER FOR RENDER / 24/7
// ==========================================
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        bot: 'WifhPaws',
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(port, () => {
  console.log(`🌐 Health check server listening on port ${port}`);
});

// Launch Bot
bot.launch().then(() => {
  console.log('🐾 WifhPaws Bot running with custodial wallet and dynamic keywords support!');
}).catch((err) => {
  console.error('❌ Failed to start bot:', err.message);
});

// Graceful shutdown
const stopBot = (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Gracefully stopping...`);
  server.close();
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
