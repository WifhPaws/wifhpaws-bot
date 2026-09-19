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
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY?.trim() || '';
const WIFH_CONTRACT_ADDRESS = process.env.WIFH_CONTRACT_ADDRESS?.trim() || '';
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com';

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY || !WALLET_ENCRYPTION_KEY) {
  throw new Error('Missing required environment variables in .env file (ensure WALLET_ENCRYPTION_KEY is set).');
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL);

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (boolean)',
];

const COOLDOWN_SECONDS = 60;

// Central Project Rewards Treasury Signer
let treasurySigner: ethers.Wallet | null = null;
if (TREASURY_PRIVATE_KEY) {
  try {
    treasurySigner = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
  } catch (err: any) {
    console.error('⚠️ Could not initialize Treasury Signer:', err.message);
  }
}

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
// WALLET MANAGEMENT & HELPER FUNCTIONS
// ==========================================
async function getOrCreateWallet(telegramId: number): Promise<{ public_address: string; encrypted_private_key: string }> {
  const { data: existingWallet } = await supabase
    .from('user_wallets')
    .select('public_address, encrypted_private_key')
    .eq('telegram_id', telegramId)
    .single();

  if (existingWallet) return existingWallet;

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
    throw new Error(`Failed to create wallet: ${error?.message}`);
  }

  // Update wallet_address in users table
  await supabase
    .from('users')
    .update({ wallet_address: newWallet.address })
    .eq('telegram_id', telegramId);

  return createdWallet;
}

function isAdmin(userId: number): boolean {
  return ADMIN_USER_IDS.includes(userId.toString());
}

async function getTargetUser(ctx: Context): Promise<{ id: number; username?: string } | null> {
  const message = ctx.message as any;
  if (!message || !message.text) return null;

  if (message.reply_to_message?.from) {
    return {
      id: message.reply_to_message.from.id,
      username: message.reply_to_message.from.username,
    };
  }

  const args = message.text.split(/\s+/).slice(1);
  if (args.length > 0) {
    const target = args[0].replace('@', '');
    if (!isNaN(Number(target))) return { id: Number(target) };

    const { data } = await supabase
      .from('users')
      .select('telegram_id, username')
      .ilike('username', target)
      .single();

    if (data) return { id: data.telegram_id, username: data.username };
  }

  return null;
}

function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|\\s|[.,!?;:()""''])${escaped}([.,!?;:()""'']|\\s|$)`, 'i');
  return regex.test(text);
}

// ==========================================
// WELCOME & USER INTERACTION COMMANDS
// ==========================================

bot.command('start', async (ctx) => {
  const args = (ctx.message as any)?.text?.split(/\s+/)[1];
  if (args === 'wallet' && ctx.chat.type === 'private') {
    try {
      const wallet = await getOrCreateWallet(ctx.from.id);
      return ctx.reply(
        `🐾 *Your WifhPaws Wallet is Ready!*\n\n` +
        `📍 *Address:*\n\`${wallet.public_address}\`\n\n` +
        `Type \`/wallet\` to open your interactive dashboard!`,
        { parse_mode: 'Markdown' }
      );
    } catch (e: any) {
      return ctx.reply(`❌ Error: ${e.message}`);
    }
  }

  const welcomeText =
    `🐾 *Welcome to WifhPaws Bot!*\n\n` +
    `Engage in community chats to earn Paw Points and manage your Robinhood Chain EVM wallet.\n\n` +
    `📌 *Available Commands:*\n` +
    `• \`/wallet\` - View your wallet balance & interactive menu\n` +
    `• \`/send\` - Transfer ETH or WIFH on Robinhood Chain\n` +
    `• \`/leaderboard\` - Check top 10 Paw Point holders\n` +
    `• \`/keywords\` - View active chat reward words\n\n` +
    `💡 *Tip:* Chat naturally in groups to unlock rewards automatically!`;

  return ctx.reply(welcomeText, { parse_mode: 'Markdown' });
});

bot.command('wallet', async (ctx) => {
  if (ctx.chat.type !== 'private') {
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
    let ethBalance = '0.0000';
    try {
      const ethBalanceWei = await provider.getBalance(wallet.public_address);
      ethBalance = parseFloat(ethers.formatEther(ethBalanceWei)).toFixed(4);
    } catch (e: any) {
      console.warn('[Wallet] RPC error fetching ETH balance:', e.message);
    }

    let wifhBalance = '0.0';
    if (WIFH_CONTRACT_ADDRESS) {
      try {
        const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
        const rawBalance = await tokenContract.balanceOf(wallet.public_address);
        const decimals = await tokenContract.decimals();
        wifhBalance = ethers.formatUnits(rawBalance, decimals);
      } catch (e) {
        wifhBalance = '0.0 (Unconfigured Address)';
      }
    }

    const messageText =
      `🐾 *WifhPaws Wallet Dashboard*\n\n` +
      `📍 *Address:*\n\`${wallet.public_address}\`\n\n` +
      `💰 *Balances (Robinhood Chain):*\n` +
      `• *ETH (Gas):* \`${ethBalance} ETH\`\n` +
      `• *WIFH Token:* \`${wifhBalance}\`\n\n` +
      `Choose an option below:`;

    return ctx.reply(
      messageText,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📥 Receive', 'action_receive'),
            Markup.button.callback('💸 Send', 'action_send_guide'),
          ],
          [
            Markup.button.callback('🔑 Export Private Key', 'action_export_key'),
          ],
        ]),
      }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Error accessing wallet: ${err.message}`);
  }
});

// Callback Actions
bot.action('action_receive', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const wallet = await getOrCreateWallet(telegramId);
    return ctx.reply(
      `📥 *Deposit Funds*\n\nSend ETH or WIFH on *Robinhood Chain* to your address below:\n\n\`${wallet.public_address}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (e: any) {
    return ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.action('action_send_guide', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    `💸 *How to Send Funds*\n\n` +
    `Use the \`/send\` command in private chat:\n\n` +
    `• *To External Wallet:*\n\`/send [amount] [eth/wifh] [0xAddress]\`\n\n` +
    `• *To Telegram User:*\n\`/send [amount] [eth/wifh] [@username]\`\n\n` +
    `*Examples:*\n` +
    `• \`/send 10 wifh @username\`\n` +
    `• \`/send 0.001 eth 0x1234567890abcdef1234567890abcdef12345678\``,
    { parse_mode: 'Markdown' }
  );
});

bot.action('action_export_key', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const { data: wallet } = await supabase
      .from('user_wallets')
      .select('encrypted_private_key')
      .eq('telegram_id', telegramId)
      .single();

    if (!wallet) return ctx.reply('❌ No wallet found.');
    const privateKey = decryptPrivateKey(wallet.encrypted_private_key);

    return ctx.reply(
      `⚠️ *CONFIDENTIAL PRIVATE KEY*\n\nDo not share this key with anyone!\n\n🔑 \`${privateKey}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Error decrypting key: ${err.message}`);
  }
});

// Transfer Command (/send)
bot.command('send', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🔒 Transfers can only be initiated in private messages for security.');
  }

  const messageText = (ctx.message as any)?.text || '';
  const args = messageText.trim().split(/\s+/).filter(Boolean);

  if (args.length < 4) {
    return ctx.reply(
      '⚠️ *Usage:* `/send [amount] [eth/wifh] [0xAddress or @username]`\n\n' +
      '*Examples:*\n• `/send 10 wifh @username`\n• `/send 0.001 eth 0x123...`',
      { parse_mode: 'Markdown' }
    );
  }

  const amountStr = args[1];
  const tokenType = args[2].toLowerCase();
  const recipientInput: string = String(args[3] || '');

  if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
    return ctx.reply('❌ Please enter a valid positive amount.');
  }

  try {
    const senderData = await getOrCreateWallet(ctx.from.id);
    const privateKey = decryptPrivateKey(senderData.encrypted_private_key);
    const signer = new ethers.Wallet(privateKey, provider);

    let destinationAddress = '';
    const isEthAddress: boolean = (ethers.isAddress as any)(recipientInput);

    if (isEthAddress) {
      destinationAddress = recipientInput;
    } else {
      const cleanUsername = String(recipientInput).replace(/^@/, '');
      const { data: recipientUser } = await supabase
        .from('users')
        .select('telegram_id')
        .ilike('username', cleanUsername)
        .single();

      if (!recipientUser) {
        return ctx.reply(`❌ Could not find a registered user named @${cleanUsername}.`);
      }
      const recipientWallet = await getOrCreateWallet(recipientUser.telegram_id);
      destinationAddress = recipientWallet.public_address;
    }

    const ethBalance = await provider.getBalance(signer.address);
    if (ethBalance === 0n) {
      return ctx.reply('⚠️ You do not have enough native ETH on Robinhood Chain to pay for gas fees.');
    }

    const statusMsg = await ctx.reply('⏳ Processing transaction on Robinhood Chain...');
    let txHash = '';

    if (tokenType === 'eth') {
      const tx = await signer.sendTransaction({
        to: destinationAddress,
        value: ethers.parseEther(amountStr),
      });
      txHash = tx.hash;
      await tx.wait();
    } else if (tokenType === 'wifh') {
      if (!WIFH_CONTRACT_ADDRESS) {
        return ctx.reply('❌ WIFH contract address is not configured in Render environment variables yet.');
      }
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, signer);
      const decimals = await contract.decimals();
      const tx = await contract.transfer(destinationAddress, ethers.parseUnits(amountStr, decimals));
      txHash = tx.hash;
      await tx.wait();
    } else {
      return ctx.reply('❌ Unsupported token. Use `eth` or `wifh`.');
    }

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ *Transaction Successful!*\n\n💸 *Amount:* \`${amountStr} ${tokenType.toUpperCase()}\`\n📍 *To:* \`${destinationAddress}\`\n🔗 *Tx Hash:* \`${txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Transaction failed: ${err.message}`);
  }
});

// ==========================================
// ADMIN-ONLY TREASURY AIRDROP COMMAND
// ==========================================

bot.command('airdrop', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdmin(senderId)) {
    return ctx.reply('⛔ Unauthorized. Only project admins can trigger token airdrops.');
  }

  if (!treasurySigner) {
    return ctx.reply('❌ Project Treasury wallet is not configured. Add `TREASURY_PRIVATE_KEY` to Render environment variables.');
  }

  if (!WIFH_CONTRACT_ADDRESS) {
    return ctx.reply('❌ WIFH contract address is not configured. Add `WIFH_CONTRACT_ADDRESS` to Render environment variables.');
  }

  const messageText = (ctx.message as any)?.text || '';
  const args = messageText.trim().split(/\s+/).filter(Boolean);
  if (args.length < 3) {
    return ctx.reply(
      '⚠️ *Admin Airdrop Usage:* `/airdrop [@username or 0xAddress] [amount]`\n\n' +
      '*Example:*\n`/airdrop @username 500`',
      { parse_mode: 'Markdown' }
    );
  }

  const targetInput: string = String(args[1] || '');
  const amountStr = args[2];

  if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
    return ctx.reply('❌ Invalid airdrop amount.');
  }

  try {
    let destinationAddress = '';
    const isEthAddress: boolean = (ethers.isAddress as any)(targetInput);

    if (isEthAddress) {
      destinationAddress = targetInput;
    } else {
      const targetUser = await getTargetUser(ctx);
      if (!targetUser) return ctx.reply('❌ Target user not found in database.');
      const wallet = await getOrCreateWallet(targetUser.id);
      destinationAddress = wallet.public_address;
    }

    const statusMsg = await ctx.reply('⏳ Executing Treasury Airdrop on Robinhood Chain...');

    const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
    const decimals = await contract.decimals();
    const tx = await contract.transfer(destinationAddress, ethers.parseUnits(amountStr, decimals));
    await tx.wait();

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `🎉 *AIRDROP SUCCESSFUL!*\n\n` +
      `🎁 *Amount:* \`${amountStr} WIFH\`\n` +
      `📍 *Recipient:* \`${destinationAddress}\`\n` +
      `🔗 *Tx Hash:* \`${tx.hash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Airdrop failed: ${err.message}`);
  }
});

// ==========================================
// PUBLIC & ADMIN CONTROL COMMANDS
// ==========================================

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
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  const args = (ctx.message as any)?.text?.split(/\s+/).filter(Boolean) || [];
  const amount = parseInt(args[args.length - 1], 10);
  if (isNaN(amount)) return ctx.reply('⚠️ Usage: `/addpoints [amount]` or `/addpoints @username [amount]`');

  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('❌ User not found.');

  const { data: user } = await supabase.from('users').select('paw_points').eq('telegram_id', targetUser.id).single();
  const newBalance = (user?.paw_points || 0) + amount;

  await supabase.from('users').upsert({ telegram_id: targetUser.id, paw_points: newBalance, points: newBalance }, { onConflict: 'telegram_id' });
  return ctx.reply(`🎉 Added ${amount} Paw Points to ${targetUser.username ? '@' + targetUser.username : targetUser.id}. New Balance: ${newBalance}`);
});

bot.command('resetpoints', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('⚠️ Usage: `/resetpoints @username`');

  await supabase.from('users').upsert({ telegram_id: targetUser.id, paw_points: 0, points: 0 }, { onConflict: 'telegram_id' });
  return ctx.reply(`🔄 Reset Paw Points to 0 for ${targetUser.username ? '@' + targetUser.username : targetUser.id}.`);
});

bot.command('addkeyword', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  const args = (ctx.message as any)?.text?.split(/\s+/).slice(1) || [];
  if (args.length < 2) return ctx.reply('⚠️ Usage: `/addkeyword [word] [points]`');

  const keyword = args[0].toLowerCase().trim();
  const points = parseInt(args[1], 10);
  if (isNaN(points) || points <= 0) return ctx.reply('❌ Points must be a positive number.');

  const { error } = await supabase.from('dynamic_keywords').upsert({ keyword, points_reward: points }, { onConflict: 'keyword' });
  if (error) return ctx.reply(`❌ Failed to add keyword: ${error.message}`);
  return ctx.reply(`✅ Keyword "${keyword}" set to reward ${points} Paw Points!`);
});

bot.command('removekeyword', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  const args = (ctx.message as any)?.text?.split(/\s+/).slice(1) || [];
  if (args.length < 1) return ctx.reply('⚠️ Usage: `/removekeyword [word]`');

  const keyword = args[0].toLowerCase().trim();
  const { error } = await supabase.from('dynamic_keywords').delete().eq('keyword', keyword);
  if (error) return ctx.reply(`❌ Failed to delete keyword: ${error.message}`);
  return ctx.reply(`🗑️ Keyword "${keyword}" removed.`);
});

bot.command('keywords', async (ctx) => {
  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');
  if (!keywords || keywords.length === 0) return ctx.reply('ℹ️ No custom rewarded keywords registered.');

  let text = '🔑 *Active Rewarded Keywords:*\n\n';
  keywords.forEach((k) => {
    text += `• \`${k.keyword}\`: +${k.points_reward} Paw Points\n`;
  });

  return ctx.reply(text, { parse_mode: 'Markdown' });
});

// Chat Message Listener for Keyword Rewards
bot.on(message('text'), async (ctx, next) => {
  const msg = ctx.message as any;
  if (!msg || !msg.text || msg.text.startsWith('/') || ctx.from?.is_bot) return next();

  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const text = msg.text.toLowerCase();

  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');
  if (!keywords || keywords.length === 0) return next();

  const matchedKeyword = keywords.find((k) => matchesKeyword(text, k.keyword));
  if (!matchedKeyword) return next();

  const { data: user } = await supabase
    .from('users')
    .select('paw_points, last_awarded_at')
    .eq('telegram_id', userId)
    .single();

  const now = new Date();
  if (user?.last_awarded_at) {
    const lastAwarded = new Date(user.last_awarded_at);
    const diffInSeconds = (now.getTime() - lastAwarded.getTime()) / 1000;
    if (diffInSeconds < COOLDOWN_SECONDS) return next();
  }

  const currentPoints = user?.paw_points || 0;
  const newBalance = currentPoints + matchedKeyword.points_reward;

  await supabase.from('users').upsert(
    {
      telegram_id: userId,
      username: username,
      paw_points: newBalance,
      points: newBalance,
      last_awarded_at: now.toISOString(),
    },
    { onConflict: 'telegram_id' }
  );

  await ctx.reply(
    `🐾 +${matchedKeyword.points_reward} Paw Points awarded to ${username ? '@' + username : 'you'} for "${matchedKeyword.keyword}"! Total: ${newBalance}`,
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
bot.launch().then(() => console.log('🐾 WifhPaws Bot running with Treasury Airdrop Engine!'));

const stopBot = (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Stopping bot...`);
  server.close();
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
