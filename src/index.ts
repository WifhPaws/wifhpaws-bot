import http from 'http';
import fs from 'fs';
import path from 'path';
import { Telegraf, Context, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const WALLET_ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '';
const WIFH_CONTRACT_ADDRESS = process.env.WIFH_CONTRACT_ADDRESS || '';
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const WEBAPP_URL = (process.env.WEBAPP_URL?.trim() || 'https://wifhpaws-bot.onrender.com/') + '?v=' + Date.now();

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY || !WALLET_ENCRYPTION_KEY) {
  throw new Error('Missing required environment variables in .env file.');
}

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err: any, ctx) => {
  console.error(`Telegram error in ${ctx.updateType}:`, err?.message || err);
});
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Use service role key for server-side reads to bypass RLS
const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
);
const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL);

// ==========================================
// IN-MEMORY CACHE (refreshed every 2 min)
// ==========================================
let cachedChatTriggers: { keyword: string; response: string }[] = [];
let cachedPointKeywords: { keyword: string; points_reward: number }[] = [];

async function refreshTriggerCache() {
  const { data: triggers, error: te } = await supabaseAdmin.from('chat_triggers').select('keyword, response');
  if (te) { console.error('[cache] chat_triggers error:', te.message); }
  else { cachedChatTriggers = triggers || []; console.log(`[cache] Loaded ${cachedChatTriggers.length} chat triggers`); }

  const { data: keywords, error: ke } = await supabaseAdmin.from('dynamic_keywords').select('keyword, points_reward');
  if (ke) { console.error('[cache] dynamic_keywords error:', ke.message); }
  else { cachedPointKeywords = keywords || []; console.log(`[cache] Loaded ${cachedPointKeywords.length} point keywords`); }
}

// Load on startup, then refresh every 2 minutes
refreshTriggerCache();
setInterval(refreshTriggerCache, 2 * 60 * 1000);

const DEX_ROUTER_ADDRESS = process.env.DEX_ROUTER_ADDRESS || '0xcaf681a66d020601342297493863e78c959e5cb2';
const WETH_ADDRESS = process.env.WETH_ADDRESS || '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const UNISWAP_V3_POOL_ADDRESS = '0xCE6d96eb098B8b7c158B7580bf4d12f387E93565';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const COOLDOWN_SECONDS = 60;

// Central Project Rewards Treasury Signer
let treasurySigner: ethers.Wallet | null = null;
if (TREASURY_PRIVATE_KEY) {
  treasurySigner = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

const MASTER_KEY_HEX = process.env.ENCRYPTION_MASTER_KEY || process.env.WALLET_ENCRYPTION_KEY || '';
let MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');
if (MASTER_KEY.length !== 32) {
  // Safeguard: if the environment variable isn't a perfect 32-byte hex string,
  // we derive a 32-byte key from it so AES-256-GCM doesn't crash.
  MASTER_KEY = crypto.scryptSync(process.env.WALLET_ENCRYPTION_KEY!, 'salt', 32);
}

export function encryptPrivateKey(privateKey: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encryptedData: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag
  };
}

export function decryptPrivateKey(walletRow: any): string {
  // Legacy decryption fallback
  if (walletRow.encrypted_private_key && walletRow.encrypted_private_key.includes(':')) {
    const [ivHex, authTagHex, encryptedText] = walletRow.encrypted_private_key.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = crypto.scryptSync(process.env.WALLET_ENCRYPTION_KEY!, 'salt', 32);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // New decryption
  const iv = Buffer.from(walletRow.encryption_iv, 'hex');
  const authTag = Buffer.from(walletRow.encryption_auth_tag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(walletRow.encrypted_private_key, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

let cachedEthPrice = 2500;
let lastEthPriceFetch = 0;

async function getEthPriceUsd(): Promise<number> {
  const now = Date.now();
  if (now - lastEthPriceFetch < 60000 && cachedEthPrice > 0) return cachedEthPrice;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = (await res.json()) as any;
    if (data && data.price) {
      cachedEthPrice = parseFloat(data.price);
      lastEthPriceFetch = now;
      return cachedEthPrice;
    }
  } catch (e) {
    console.warn('Live ETH price fetch failed, using fallback:', e);
  }
  return cachedEthPrice;
}

let cachedPoolRate = 28000000;
let lastPoolRateFetch = 0;

async function getPoolRate(): Promise<number> {
  const now = Date.now();
  if (now - lastPoolRateFetch < 30000 && cachedPoolRate > 0) return cachedPoolRate;
  try {
    const pool = new ethers.Contract(
      UNISWAP_V3_POOL_ADDRESS,
      ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'],
      provider
    );
    const s0 = await pool.slot0();
    const sqrtPriceX96 = s0[0];
    const q96 = 2n ** 96n;
    const ratio = Number(sqrtPriceX96) / Number(q96);
    cachedPoolRate = ratio * ratio;
    lastPoolRateFetch = now;
    return cachedPoolRate;
  } catch (e: any) {
    console.warn('Live pool rate fetch failed, using fallback:', e?.message || e);
    return cachedPoolRate;
  }
}

async function getWifhPriceUsd(): Promise<number> {
  const ethPrice = await getEthPriceUsd();
  const poolRate = await getPoolRate();
  return ethPrice / poolRate;
}

// Direct on-chain Uniswap V3 Swap Execution (Treasury is NEVER used as counterparty)
async function executeOnChainSwap(
  userWallet: any | null,
  fromToken: 'eth' | 'wifh',
  toToken: 'eth' | 'wifh',
  amount: number,
  customSigner?: ethers.Wallet
): Promise<{ txHash: string; received: string; receivedUsd: string }> {
  if (!DEX_ROUTER_ADDRESS || !WIFH_CONTRACT_ADDRESS) {
    throw new Error('DEX router or WIFH contract address is not configured.');
  }

  let signer = customSigner;
  if (!signer) {
    if (!userWallet) throw new Error('No wallet provided');
    const privateKey = decryptPrivateKey(userWallet);
    signer = new ethers.Wallet(privateKey, provider);
  }
  const routerContract = new ethers.Contract(DEX_ROUTER_ADDRESS, UNISWAP_V3_ROUTER_ABI, signer);
  const ethPrice = await getEthPriceUsd();
  const poolRate = await getPoolRate();
  const wifhPrice = ethPrice / poolRate;

  let txHash = '';
  let received = '0';
  let receivedUsd = '0.00';

  if (fromToken === 'eth') {
    const ethValWei = ethers.parseEther(amount.toFixed(18));
    const userEthBal = await provider.getBalance(signer.address);
    if (userEthBal < ethValWei) {
      throw new Error(`Insufficient ETH balance. You have ${parseFloat(ethers.formatEther(userEthBal)).toFixed(6)} ETH but need ${amount.toFixed(6)} ETH.`);
    }

    const params = {
      tokenIn: WETH_ADDRESS,
      tokenOut: WIFH_CONTRACT_ADDRESS,
      fee: 10000,
      recipient: signer.address,
      amountIn: ethValWei,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    };

    let expectedWifh = 0n;
    try {
      expectedWifh = await routerContract.exactInputSingle.staticCall(params, { value: ethValWei });
    } catch (e: any) {
      console.warn('Swap simulation warning:', e.message);
    }

    const tx = await routerContract.exactInputSingle(params, { value: ethValWei, gasLimit: 350000n });
    txHash = tx.hash;
    await tx.wait();

    if (expectedWifh > 0n) {
      received = ethers.formatUnits(expectedWifh, 18);
    } else {
      received = (amount * poolRate).toFixed(2);
    }
    receivedUsd = (parseFloat(received) * wifhPrice).toFixed(2);

  } else {
    // WIFH -> ETH
    const wifhContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, signer);
    const decimals = await wifhContract.decimals();
    const wifhAmountWei = ethers.parseUnits(amount.toFixed(Number(decimals)), decimals);

    const userWifhBal = await wifhContract.balanceOf(signer.address);
    if (userWifhBal < wifhAmountWei) {
      throw new Error(`Insufficient WIFH balance. You have ${ethers.formatUnits(userWifhBal, decimals)} WIFH but need ${amount} WIFH.`);
    }

    const currentAllowance = await wifhContract.allowance(signer.address, DEX_ROUTER_ADDRESS);
    if (currentAllowance < wifhAmountWei) {
      const appTx = await wifhContract.approve(DEX_ROUTER_ADDRESS, ethers.MaxUint256, { gasLimit: 100000n });
      await appTx.wait();
    }

    const params = {
      tokenIn: WIFH_CONTRACT_ADDRESS,
      tokenOut: WETH_ADDRESS,
      fee: 10000,
      recipient: signer.address,
      amountIn: wifhAmountWei,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    };

    const tx = await routerContract.exactInputSingle(params, { gasLimit: 350000n });
    txHash = tx.hash;
    await tx.wait();

    // Unwrap WETH into native ETH
    const wethContract = new ethers.Contract(WETH_ADDRESS, [
      'function balanceOf(address) view returns (uint256)',
      'function withdraw(uint256 wad) public',
    ], signer);

    const wethBal = await wethContract.balanceOf(userWallet.public_address);
    if (wethBal > 0n) {
      const withdrawTx = await wethContract.withdraw(wethBal, { gasLimit: 100000n });
      await withdrawTx.wait();
      received = ethers.formatEther(wethBal);
    } else {
      received = (amount / poolRate).toFixed(6);
    }
    receivedUsd = (parseFloat(received) * ethPrice).toFixed(2);
  }

  return { txHash, received, receivedUsd };
}

// ==========================================
// WALLET MANAGEMENT & HELPER FUNCTIONS
// ==========================================
async function getOrCreateWallet(telegramId: number): Promise<any> {
  const { data: existingWallet } = await supabase
    .from('user_wallets')
    .select('public_address, encrypted_private_key, encryption_iv, encryption_auth_tag')
    .eq('telegram_id', telegramId)
    .single();

  if (existingWallet) return existingWallet;

  const newWallet = ethers.Wallet.createRandom();
  const { encryptedData, iv, authTag } = encryptPrivateKey(newWallet.privateKey);

  const { data: createdWallet, error } = await supabase
    .from('user_wallets')
    .insert({
      telegram_id: telegramId,
      public_address: newWallet.address,
      encrypted_private_key: encryptedData,
      encryption_iv: iv,
      encryption_auth_tag: authTag
    })
    .select('public_address, encrypted_private_key, encryption_iv, encryption_auth_tag')
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

let dynamicAdmins = new Set<string>();

async function loadDynamicAdmins() {
  try {
    const { data, error } = await supabase.from('admins').select('telegram_id');
    if (!error && data) {
      data.forEach((row: any) => dynamicAdmins.add(row.telegram_id.toString()));
    }
  } catch (err) {
    console.warn('Could not load dynamic admins. (Table might not exist yet).');
  }
}
loadDynamicAdmins();

function isAdmin(userId: number): boolean {
  const adminSingle = process.env.ADMIN_TELEGRAM_ID?.trim();
  const idStr = userId.toString();
  return ADMIN_USER_IDS.includes(idStr) || (adminSingle === idStr) || dynamicAdmins.has(idStr);
}

function isSuperAdmin(userId: number): boolean {
  const adminSingle = process.env.ADMIN_TELEGRAM_ID?.trim();
  const idStr = userId.toString();
  return ADMIN_USER_IDS.includes(idStr) || (adminSingle === idStr);
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

  const args = message.text.split(' ').slice(1);
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

// ==========================================
// WELCOME & USER INTERACTION COMMANDS
// ==========================================

bot.command('start', async (ctx) => {
  const userId = ctx.from?.id;
  const message = ctx.message as any;
  const args = message?.text?.split(/\s+/)[1];

  if (args === 'wallet' && ctx.chat.type === 'private') {
    return sendWalletDashboard(ctx, ctx.from.id);
  }

  if (args === 'send' && ctx.chat.type === 'private') {
    return ctx.reply(
      `\u{1F4B8} *How to Send Funds*\n\nUse the \`/send\` command in private chat:\n\n\u2022 *To External Wallet:*\n\`/send [amount] [eth/wifh] [0xAddress]\`\n\n\u2022 *To Telegram User:*\n\`/send [amount] [eth/wifh] [@username]\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
    );
  }

  // In group chats: ALWAYS show the standard welcome, never admin panel
  if (ctx.chat.type !== 'private') {
    return ctx.reply(
      `\u{1F43E} *Welcome to WifhPaws Bot!*\n\n` +
      `Engage in group chats to earn hidden Paw Points and manage your Robinhood Chain EVM wallet.\n\n` +
      `\u{1F4CC} *Chat Commands:*\n` +
      `\u2022 \`/wallet\` \u2014 View wallet balance & manage funds\n` +
      `\u2022 \`/leaderboard\` \u2014 Top 10 Paw Point holders\n\n` +
      `\u{1F4A1} *Tip:* Chat naturally in groups \u2014 secret keywords earn you Paw Points!`,
      { parse_mode: 'Markdown' }
    );
  }

  // Private chat: show admin panel for admins, wallet dashboard for regular users
  if (userId && isAdmin(userId)) {
    const adminKeyboard: any[] = [
      [
        { text: "\u{1F3E6} View Treasury", callback_data: "admin_treasury" },
        { text: "\u{1FA82} Airdrop Token", callback_data: "admin_airdrop" }
      ],
      [
        { text: "\u2699\uFE0F Reset Points", callback_data: "admin_reset" },
        { text: "\u{1F511} Keywords", callback_data: "admin_keywords" }
      ],
      [
        { text: "\u2753 Help Guide", callback_data: "admin_help" },
        { text: "🏛️ Treasury Wallet Dashboard", callback_data: "action_treasury_home" }
      ],
      [
        { text: "⬅️ Back", callback_data: "action_back_to_start" }
      ]
    ];
    return ctx.reply("🛡️ *WifhPaws Admin & Treasury Control*", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: adminKeyboard }
    });
  } else {
    // Regular user private chat: show wallet dashboard
    return sendWalletDashboard(ctx, userId!);
  }
});

async function sendWalletDashboard(ctx: any, telegramId: number, edit: boolean = false, isTreasury: boolean = false) {
  try {
    let address = '';
    let ethBalance = '0.0000';
    let wifhBalance = '0.0';

    if (isTreasury) {
      if (!treasurySigner) return ctx.reply('❌ Treasury wallet is not configured in .env.');
      address = treasurySigner.address;
    } else {
      const wallet = await getOrCreateWallet(telegramId);
      address = wallet.public_address;
    }

    try {
      const ethBalanceWei = await provider.getBalance(address);
      ethBalance = parseFloat(ethers.formatEther(ethBalanceWei)).toFixed(4);
    } catch (e: any) {
      console.warn('RPC ETH balance error:', e.message);
    }

    if (WIFH_CONTRACT_ADDRESS) {
      try {
        const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
        const rawBalance = await tokenContract.balanceOf(address);
        const decimals = await tokenContract.decimals();
        wifhBalance = ethers.formatUnits(rawBalance, decimals);
      } catch (e) {
        wifhBalance = '0.0';
      }
    }

    const title = isTreasury ? '🏛️ *WifhPaws Treasury Wallet*' : '🐾 *WifhPaws Wallet Dashboard*';
    const messageText = `${title}\n\n📍 *Address:*\n\`${address}\`\n\n💰 *Balances (Robinhood Chain):*\n• *ETH (Gas):* \`${ethBalance} ETH\`\n• *WIFH Token:* \`${wifhBalance}\`\n\nChoose an option below:`;

    const webAppUrl = isTreasury ? WEBAPP_URL + '&mode=treasury' : WEBAPP_URL;
    
    const prefix = isTreasury ? 'treasury_' : '';
    const keyboard: any[] = [
      [{ text: '🚀 Launch Mini App Dashboard', web_app: { url: webAppUrl } }],
      [{ text: '📥 Receive', callback_data: `action_${prefix}receive` }, { text: '💸 Send', callback_data: `action_${prefix}send_guide` }],
      [{ text: '🔄 Swap Tokens', callback_data: `action_${prefix}swap` }]
    ];

    if (!isTreasury) {
      keyboard[2].push({ text: '🔐 Export Private Key', callback_data: 'action_export_key' });
    }

    if (isAdmin(telegramId)) {
      keyboard.push([{ text: '🛡️ Open Admin Panel', callback_data: 'action_open_admin' }]);
    }

    if (edit) {
      return ctx.editMessageText(
        messageText.replace(/([-_ *\[\]().~`>#+=|{}.!])/g, '\\$1'),
        { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: keyboard } }
      );
    } else {
      return ctx.replyWithMarkdownV2(
        messageText.replace(/([-_ *\[\]().~`>#+=|{}.!])/g, '\\$1'),
        { reply_markup: { inline_keyboard: keyboard } }
      );
    }
  } catch (err: any) {
    return ctx.reply(`❌ Error accessing wallet: ${err.message}`);
  }
}

bot.command('wallet', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    const botUsername = ctx.botInfo?.username || 'WifhPawsBot';
    return ctx.reply(
      '\u{1F512} For your privacy and security, wallet details are managed in private messages.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '\u{1F4E9} Open Private Wallet', url: `https://t.me/${botUsername}?start=wallet` }]
          ]
        }
      }
    );
  }
  return sendWalletDashboard(ctx, ctx.from.id);
});

// Callback Actions
const BACK_TO_WALLET = [[{ text: '⬅️ Back to Personal Wallet', callback_data: 'action_wallet_home' }]];
const BACK_TO_TREASURY = [[{ text: '⬅️ Back to Treasury', callback_data: 'action_treasury_home' }]];
const BACK_TO_ADMIN = [[{ text: '⬅️ Back to Admin Panel', callback_data: 'action_open_admin' }]];

bot.action('action_wallet_home', async (ctx) => {
  await ctx.answerCbQuery();
  return sendWalletDashboard(ctx, ctx.from.id, true, false);
});

bot.action('action_treasury_home', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  return sendWalletDashboard(ctx, ctx.from.id, true, true);
});

bot.action('action_receive', async (ctx) => {
  await ctx.answerCbQuery();
  const wallet = await getOrCreateWallet(ctx.from.id);
  return ctx.editMessageText(
    `📥 *Deposit Funds*\n\nSend ETH or WIFH on *Robinhood Chain* to your address below:\n\n\`${wallet.public_address}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
  );
});

bot.action('action_treasury_receive', async (ctx) => {
  await ctx.answerCbQuery();
  if (!treasurySigner) return ctx.reply('❌ Treasury not configured.');
  return ctx.editMessageText(
    `📥 *Treasury Deposit*\n\nSend ETH or WIFH on *Robinhood Chain* to the Treasury address below:\n\n\`${treasurySigner.address}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_TREASURY } }
  );
});

bot.action('action_send_guide', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `💸 *How to Send Funds*\n\nUse the \`/send\` command in private chat:\n\n• *To External Wallet:*\n\`/send [amount] [eth/wifh] [0xAddress]\`\n\n• *To Telegram User:*\n\`/send [amount] [eth/wifh] [@username]\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
  );
});

bot.action('action_treasury_send_guide', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `💸 *How to Send Treasury Funds*\n\nUse the \`/tsend\` command in private chat (Admins only):\n\n• *To External Wallet:*\n\`/tsend [amount] [eth/wifh] [0xAddress]\`\n\n• *To Telegram User:*\n\`/tsend [amount] [eth/wifh] [@username]\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_TREASURY } }
  );
});

bot.action('action_swap', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `🔄 *Token Swap Guide*\n\n` +
    `Swap WIFH and ETH instantly using the command:\n\n` +
    `• *Swap WIFH for ETH:*\n\`/swap [amount] wifh eth\`\n_Example:_ \`/swap 100 wifh eth\`\n\n` +
    `• *Swap ETH for WIFH:*\n\`/swap [amount] eth wifh\`\n_Example:_ \`/swap 0.01 eth wifh\`\n\n` +
    `💡 *Tip:* You can also launch the Mini App for a visual Swap interface!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
  );
});

bot.action('action_treasury_swap', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `🔄 *Treasury Token Swap Guide*\n\n` +
    `Swap Treasury WIFH and ETH using the command (Admins only):\n\n` +
    `• *Swap WIFH for ETH:*\n\`/tswap [amount] wifh eth\`\n_Example:_ \`/tswap 100 wifh eth\`\n\n` +
    `• *Swap ETH for WIFH:*\n\`/tswap [amount] eth wifh\`\n_Example:_ \`/tswap 0.01 eth wifh\`\n\n` +
    `💡 *Tip:* You can also use the Mini App's Swap tab while in Treasury Mode!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_TREASURY } }
  );
});

bot.action('action_export_key', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const { data: wallet } = await supabase
      .from('user_wallets')
      .select('encrypted_private_key')
      .eq('telegram_id', ctx.from.id)
      .single();
    if (!wallet) return ctx.reply('\u274C No wallet found.');
    const privateKey = decryptPrivateKey(wallet);
    const sentMsg = await ctx.reply(
      `⚠️ *CONFIDENTIAL PRIVATE KEY*\n\nDo not share this key with anyone! *This message will self-destruct in 60 seconds.*\n\n🔑 \`${privateKey}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
    );
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat!.id, sentMsg.message_id).catch(() => {});
    }, 60000);
    return;
  } catch (err: any) {
    return ctx.reply(`\u274C Error decrypting key: ${err.message}`);
  }
});

bot.action('admin_treasury', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');
  if (!treasurySigner) return ctx.reply('\u274C Treasury wallet is not configured. Check TREASURY_PRIVATE_KEY.');

  try {
    const treasuryAddress = treasurySigner.address;
    const ethBalanceWei = await provider.getBalance(treasuryAddress);
    const ethBalance = ethers.formatEther(ethBalanceWei);

    let wifhBalance = '0.0';
    if (WIFH_CONTRACT_ADDRESS) {
      try {
        const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
        const rawBalance = await tokenContract.balanceOf(treasuryAddress);
        const decimals = await tokenContract.decimals();
        wifhBalance = ethers.formatUnits(rawBalance, decimals);
      } catch (e) {
        wifhBalance = '0.0';
      }
    }

    const ethPrice = await getEthPriceUsd();
    const wifhPrice = await getWifhPriceUsd();
    const ethUsd = (parseFloat(ethBalance) * ethPrice).toFixed(2);
    const wifhUsd = (parseFloat(wifhBalance) * wifhPrice).toFixed(2);

    const treasuryKeyboard = [
      [{ text: '\u{1F4E5} Deposit to Treasury', callback_data: 'admin_treasury_deposit' }],
      [
        { text: '\u{1FA82} Airdrop', callback_data: 'admin_airdrop' },
        { text: '\u{1F504} Refresh', callback_data: 'admin_treasury' }
      ],
      [{ text: '\u2B05\uFE0F Back to Admin Panel', callback_data: 'action_open_admin' }]
    ];

    return ctx.reply(
      `\u{1F3E6} *Project Treasury Wallet*\n\n` +
      `\u{1F4CD} *Address:*\n\`${treasuryAddress}\`\n\n` +
      `\u{1F4B0} *Balances (Robinhood Chain):*\n` +
      `\u2022 *ETH (Gas):* \`${parseFloat(ethBalance).toFixed(4)} ETH\` (~\$${ethUsd})\n` +
      `\u2022 *WIFH Token:* \`${parseFloat(wifhBalance).toFixed(2)} WIFH\` (~\$${wifhUsd})\n\n` +
      `\u{1F381} Airdrop: \`/airdrop [@user] [amount]\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: treasuryKeyboard } }
    );
  } catch (err: any) {
    return ctx.reply(`\u274C Error: ${err.message}`);
  }
});

bot.action('admin_treasury_deposit', async (ctx) => {
  await ctx.answerCbQuery();
  if (!treasurySigner) return ctx.reply('\u274C Treasury not configured.');
  return ctx.reply(
    `\u{1F4E5} *Fund the Treasury*\n\nSend ETH or WIFH on *Robinhood Chain* to:\n\n\`${treasurySigner.address}\`\n\n_Copy the address above and send tokens from any wallet._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '\u2B05\uFE0F Back to Treasury', callback_data: 'admin_treasury' }]] } }
  );
});

bot.action('admin_airdrop', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');
  return ctx.reply(
    `\u{1FA82} *Token Airdrop Command:*\n\n` +
    `\`/airdrop [@username or 0xAddress] [amount]\`\n\n` +
    `_Example:_ \`/airdrop @username 500\`\n\n` +
    `_Tip: "amount" is in whole WIFH tokens (e.g. 500 = 500 WIFH)_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_ADMIN } }
  );
});

bot.action('admin_reset', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');
  return ctx.reply(
    `\u2699\uFE0F *Points Reset Options:*\n\n` +
    `\u2022 \`/resetpoints @username\` \u2014 Reset single user points\n` +
    `\u2022 \`/resetallpoints\` \u2014 Reset all points on leaderboard`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_ADMIN } }
  );
});

bot.action('admin_keywords', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');
  const ADMIN_WEB_URL = (process.env.WEBAPP_URL?.trim() || 'https://wifhpaws-bot.onrender.com/').replace(/\/$/, '') + '/admin';
  const keywordsKeyboard = [
    [{ text: '🌐 Open Web Admin Panel', web_app: { url: ADMIN_WEB_URL } }],
    [{ text: '📜 List Paw-Point Keywords', callback_data: 'action_list_keywords' }],
    [{ text: '💬 List Chat Triggers', callback_data: 'action_list_triggers' }],
    [{ text: '⬅️ Back to Admin Panel', callback_data: 'action_open_admin' }]
  ]

  return ctx.reply(
    `\u{1F511} *Keywords & Triggers:*\n\n` +
    `*Paw-Point Keywords* (reward points):\n` +
    `\u2022 \`/addkeyword [phrase] [points]\` \u2014 Add a rewarded keyword\n` +
    `\u2022 \`/removekeyword [word]\` \u2014 Remove a keyword\n` +
    `\u2022 \`/clearallkeywords\` \u2014 Delete all keywords\n\n` +
    `*Chat Triggers* (auto-reply responses):\n` +
    `\u2022 \`/addtrigger keyword | response\` \u2014 Add an auto-reply\n` +
    `\u2022 \`/removetrigger keyword\` \u2014 Remove a trigger\n` +
    `\u2022 \`/cleartriggers\` \u2014 Clear all triggers`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keywordsKeyboard } }
  );
});

bot.action('action_list_keywords', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');
  
  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');
  if (!keywords || keywords.length === 0) return ctx.reply('\u2139\uFE0F No custom rewarded keywords registered.');
  let text = '\u{1F511} *Active Secret Keywords (Admin View):*\n\n';
  keywords.forEach((k) => {
    text += `\u2022 \`${k.keyword}\`: +${k.points_reward} Paw Points\n`;
  });
  
  return ctx.replyWithMarkdownV2(text.replace(/([-_ *\[\]().~`>#+=|{}.!])/g, '\\$1'), {
    reply_markup: { inline_keyboard: [[{ text: "\u2B05\uFE0F Back", callback_data: "admin_keywords" }]] }
  });
});

bot.action('action_list_triggers', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');

  const { data: triggers } = await supabase.from('chat_triggers').select('keyword, response');
  if (!triggers || triggers.length === 0) return ctx.reply('\u2139\uFE0F No custom chat triggers set.');
  let text = '\u{1F4AC} *Active Chat Triggers:*\n\n';
  triggers.forEach((t, i) => { text += `${i + 1}. \`${t.keyword}\` \u2192 _${t.response}_\n`; });
  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '\u2B05\uFE0F Back', callback_data: 'admin_keywords' }]] }
  });
});


bot.action('action_open_admin', async (ctx) => {
  await ctx.answerCbQuery();
  const senderId = ctx.from?.id;
  if (!senderId || !isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');

  const adminKeyboard: any[] = [
    [
      { text: "\u{1F3E6} View Treasury", callback_data: "admin_treasury" },
      { text: "\u{1FA82} Airdrop Token", callback_data: "admin_airdrop" }
    ],
    [
      { text: "\u2699\uFE0F Reset Points", callback_data: "admin_reset" },
      { text: "\u{1F511} Keywords", callback_data: "admin_keywords" }
    ],
    [
      { text: "\u{1F4AC} Trivia Settings", callback_data: "admin_trivia" },
      { text: "\u2753 Help Guide", callback_data: "admin_help" }
    ],
    [
      { text: "🏛️ Treasury Wallet Dashboard", callback_data: "action_treasury_home" }
    ],
    [
      { text: "⬅️ Back", callback_data: "action_wallet_home" }
    ]
  ];

  return ctx.editMessageText("🛡️ *WifhPaws Admin Control Center*\n\nSelect an option below:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: adminKeyboard }
  });
});

bot.action('admin_help', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from!.id)) return ctx.reply('\u26D4 Unauthorized.');

  const helpText = `🛡️ *Admin Commands Cheat Sheet*\n\n` +
    `👤 *Management:*\n` +
    `• \`/makeadmin @username\` — Promote a user to admin.\n` +
    `• \`/admin\` — Open the visual Admin Control Center.\n\n` +
    `🏛️ *Treasury & Tokens:*\n` +
    `• \`/treasury\` — View live project treasury balances.\n` +
    `• \`/airdrop @username 50\` — Send 50 WIFH to a user.\n` +
    `• \`/airdrop @username $10\` — Send $10 worth of WIFH.\n` +
    `• \`/tsend 10 wifh @username\` — Send from treasury.\n` +
    `• \`/tswap 10 eth wifh\` — Swap treasury funds.\n` +
    `• \`/tbuy 0.1\` — Buy WIFH with 0.1 ETH from treasury.\n` +
    `• \`/tsell 100\` — Sell 100 WIFH from treasury.\n\n` +
    `🔑 *Keyword Rewards:*\n` +
    `• \`/keywords\` — List all active keywords.\n` +
    `• \`/addkeyword hello 10\` — Reward 10 pts for saying "hello".\n` +
    `• \`/removekeyword hello\` — Delete the "hello" keyword.\n` +
    `• \`/clearallkeywords\` — Delete all keywords at once.\n\n` +
    `⭐ *Paw Points:*\n` +
    `• \`/addpoints @username 100\` — Give 100 points.\n` +
    `• \`/resetpoints @username\` — Reset one user's points to 0.\n` +
    `• \`/resetallpoints\` — Clear points for ALL users (leaderboard reset).`;

  return ctx.reply(helpText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_ADMIN } });
});

// Transfer Command (/send)
bot.command('send', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('\u{1F512} Transfers can only be initiated in private messages for security.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply('\u26A0\uFE0F *Usage:* `/send [amount] [eth/wifh] [0xAddress or @username]`\n\n*Examples:*\n\u2022 `/send 10 wifh @username`\n\u2022 `/send 0.001 eth 0x123...`', { parse_mode: 'Markdown' });
  }

  const amountStr = args[1];
  const tokenType = args[2].toLowerCase();
  const recipientInput: string = String(args[3] || '');
  if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) return ctx.reply('\u274C Please enter a valid positive amount.');

  try {
    const senderData = await getOrCreateWallet(ctx.from.id);
    const privateKey = decryptPrivateKey(senderData);
    const signer = new ethers.Wallet(privateKey, provider);

    let destinationAddress = '';
    if ((ethers.isAddress as any)(recipientInput)) {
      destinationAddress = recipientInput;
    } else {
      const cleanUsername = recipientInput.replace('@', '');
      const { data: recipientUser } = await supabase
        .from('users')
        .select('telegram_id')
        .ilike('username', cleanUsername)
        .single();
      if (!recipientUser) return ctx.reply(`\u274C Could not find a registered user named @${cleanUsername}.`);
      const recipientWallet = await getOrCreateWallet(recipientUser.telegram_id);
      destinationAddress = recipientWallet.public_address;
    }

    const ethBalance = await provider.getBalance(signer.address);
    if (ethBalance === 0n) return ctx.reply('\u26A0\uFE0F You do not have enough native ETH on Robinhood Chain to pay for gas fees.');

    const statusMsg = await ctx.reply('\u23F3 Processing transaction on Robinhood Chain...');
    let txHash = '';
    if (tokenType === 'eth') {
      const tx = await signer.sendTransaction({ to: destinationAddress, value: ethers.parseEther(amountStr), gasLimit: 100000n });
      txHash = tx.hash;
      await tx.wait();
    } else if (tokenType === 'wifh') {
      if (!WIFH_CONTRACT_ADDRESS) return ctx.reply('\u274C WIFH contract address is not configured.');
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, signer);
      const decimals = await contract.decimals();
      const tx = await contract.transfer(destinationAddress, ethers.parseUnits(amountStr, decimals), { gasLimit: 150000n });
      txHash = tx.hash;
      await tx.wait();
    } else {
      return ctx.reply('\u274C Unsupported token. Use `eth` or `wifh`.');
    }

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `\u2705 *Transaction Successful!*\n\n\u{1F4B8} *Amount:* \`${amountStr} ${tokenType.toUpperCase()}\`\n\u{1F4CD} *To:* \`${destinationAddress}\`\n\u{1F517} *Tx Hash:* \`${txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`\u274C Transaction failed: ${err.message}`);
  }
});

// Treasury Transfer Command (/tsend)
bot.command('tsend', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Transfers can only be initiated in private messages for security.');
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  if (!treasurySigner) return ctx.reply('❌ Treasury wallet is not configured in .env.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply('⚠️ *Usage:* `/tsend [amount] [eth/wifh] [0xAddress or @username]`\n\n*Examples:*\n• `/tsend 10 wifh @username`\n• `/tsend 0.001 eth 0x123...`', { parse_mode: 'Markdown' });
  }

  const amountStr = args[1];
  const tokenType = args[2].toLowerCase();
  const recipientInput: string = String(args[3] || '');
  if (isNaN(Number(amountStr)) || Number(amountStr) <= 0) return ctx.reply('❌ Please enter a valid positive amount.');

  try {
    let destinationAddress = '';
    if ((ethers.isAddress as any)(recipientInput)) {
      destinationAddress = recipientInput;
    } else {
      const cleanUsername = recipientInput.replace('@', '');
      const { data: recipientUser } = await supabase
        .from('users')
        .select('telegram_id')
        .ilike('username', cleanUsername)
        .single();
      if (!recipientUser) return ctx.reply(`❌ Could not find a registered user named @${cleanUsername}.`);
      const recipientWallet = await getOrCreateWallet(recipientUser.telegram_id);
      destinationAddress = recipientWallet.public_address;
    }

    const ethBalance = await provider.getBalance(treasurySigner.address);
    if (ethBalance === 0n) return ctx.reply('⚠️ Treasury does not have enough native ETH on Robinhood Chain to pay for gas fees.');

    const statusMsg = await ctx.reply('⏳ Processing treasury transaction on Robinhood Chain...');
    let txHash = '';
    if (tokenType === 'eth') {
      const tx = await treasurySigner.sendTransaction({ to: destinationAddress, value: ethers.parseEther(amountStr), gasLimit: 100000n });
      txHash = tx.hash;
      await tx.wait();
    } else if (tokenType === 'wifh') {
      if (!WIFH_CONTRACT_ADDRESS) return ctx.reply('❌ WIFH contract address is not configured.');
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
      const decimals = await contract.decimals();
      const tx = await contract.transfer(destinationAddress, ethers.parseUnits(amountStr, decimals), { gasLimit: 150000n });
      txHash = tx.hash;
      await tx.wait();
    } else {
      return ctx.reply('❌ Unsupported token. Use `eth` or `wifh`.');
    }

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ *Treasury Transfer Successful!*\n\n💸 *Amount:* \`${amountStr} ${tokenType.toUpperCase()}\`\n📍 *To:* \`${destinationAddress}\`\n🔗 *Tx Hash:* \`${txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Treasury transaction failed: ${err.message}`);
  }
});

// Token Swap Command (/swap)
bot.command('swap', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('\u{1F512} Swaps can only be executed in private messages for security.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply(
      '\u26A0\uFE0F *Swap Syntax:* `/swap [amount] [fromToken] [toToken]`\n\n' +
      '*Examples:*\n' +
      '\u2022 `/swap 100 wifh eth` (Swap 100 WIFH for ETH)\n' +
      '\u2022 `/swap 0.01 eth wifh` (Swap 0.01 ETH for WIFH)',
      { parse_mode: 'Markdown' }
    );
  }

  const amountStr = args[1];
  const fromToken = args[2].toLowerCase();
  const toToken = args[3].toLowerCase();
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) return ctx.reply('\u274C Please enter a valid positive swap amount.');

  if (!['wifh', 'eth'].includes(fromToken) || !['wifh', 'eth'].includes(toToken) || fromToken === toToken) {
    return ctx.reply('\u274C Invalid swap pair. Supported pairs are `wifh` ↔ `eth`.');
  }

  try {
    const statusMsg = await ctx.reply('\u23F3 Calculating rate & executing on-chain swap via DEX...');

    const senderData = await getOrCreateWallet(ctx.from.id);
    const result = await executeOnChainSwap(senderData, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount);

    const poolRate = await getPoolRate();
    const rateDisplay = fromToken === 'eth'
      ? `1 ETH = ${Math.round(poolRate).toLocaleString()} WIFH`
      : `1 WIFH = ${(1 / poolRate).toFixed(8)} ETH`;

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `\u2705 *SWAP SUCCESSFUL!*\n\n` +
      `\u{1F504} *Paid:* \`${amountStr} ${fromToken.toUpperCase()}\`\n` +
      `\u{1F389} *Received:* \`${result.received} ${toToken.toUpperCase()}\` (~\$${result.receivedUsd} USD)\n` +
      `\u{1F4C8} *Rate:* ${rateDisplay}\n` +
      `\u{1F517} *Tx:* \`${result.txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`\u274C Swap failed: ${err.message}`);
  }
});

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) return ctx.reply('⚠️ *Usage:* `/buy [amount_in_eth]`\n_Buys WIFH using ETH_', { parse_mode: 'Markdown' });
  ctx.message.text = `/swap ${args[1]} eth wifh`;
  return bot.handleUpdate(ctx.update);
});

bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) return ctx.reply('⚠️ *Usage:* `/sell [amount_in_wifh]`\n_Sells WIFH for ETH_', { parse_mode: 'Markdown' });
  ctx.message.text = `/swap ${args[1]} wifh eth`;
  return bot.handleUpdate(ctx.update);
});

// Treasury Swap Command (/tswap)
bot.command('tswap', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('\u{1F512} Swaps can only be executed in private messages.');
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Unauthorized. Only admins can swap treasury funds.');
  if (!treasurySigner) return ctx.reply('❌ Treasury wallet is not configured in .env.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply(
      '⚠️ *Treasury Swap Syntax:* `/tswap [amount] [fromToken] [toToken]`\n\n' +
      '*Examples:*\n' +
      '• `/tswap 100 wifh eth`\n' +
      '• `/tswap 0.01 eth wifh`',
      { parse_mode: 'Markdown' }
    );
  }

  const amountStr = args[1];
  const fromToken = args[2].toLowerCase();
  const toToken = args[3].toLowerCase();
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Please enter a valid positive swap amount.');

  if (!['wifh', 'eth'].includes(fromToken) || !['wifh', 'eth'].includes(toToken) || fromToken === toToken) {
    return ctx.reply('❌ Invalid swap pair. Supported pairs are `wifh` ↔ `eth`.');
  }

  try {
    const statusMsg = await ctx.reply('⏳ Calculating rate & executing treasury on-chain swap via DEX...');

    const result = await executeOnChainSwap(null, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount, treasurySigner);

    const poolRate = await getPoolRate();
    const rateDisplay = fromToken === 'eth'
      ? `1 ETH = ${Math.round(poolRate).toLocaleString()} WIFH`
      : `1 WIFH = ${(1 / poolRate).toFixed(8)} ETH`;

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ *TREASURY SWAP SUCCESSFUL!*\n\n` +
      `🔄 *Paid:* \`${amountStr} ${fromToken.toUpperCase()}\`\n` +
      `🎉 *Received:* \`${result.received} ${toToken.toUpperCase()}\` (~$${result.receivedUsd} USD)\n` +
      `📈 *Rate:* ${rateDisplay}\n` +
      `🔗 *Tx:* \`${result.txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Swap failed: ${err.message}`);
  }
});

bot.command('tbuy', async (ctx) => {
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) return ctx.reply('⚠️ *Usage:* `/tbuy [amount_in_eth]`', { parse_mode: 'Markdown' });
  ctx.message.text = `/tswap ${args[1]} eth wifh`;
  return bot.handleUpdate(ctx.update);
});

bot.command('tsell', async (ctx) => {
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) return ctx.reply('⚠️ *Usage:* `/tsell [amount_in_wifh]`', { parse_mode: 'Markdown' });
  ctx.message.text = `/tswap ${args[1]} wifh eth`;
  return bot.handleUpdate(ctx.update);
});

// ==========================================
// ADMIN HELP & TREASURY COMMANDS
// ==========================================

bot.command('adminhelp', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("\u26D4 Unauthorized.");

  const helpText = `🛡️ *Admin Commands Cheat Sheet*\n\n` +
    `👤 *Management:*\n` +
    `• \`/makeadmin @username\` — Promote a user to admin.\n` +
    `• \`/admin\` — Open the visual Admin Control Center.\n\n` +
    `🏛️ *Treasury & Tokens:*\n` +
    `• \`/treasury\` — View live project treasury balances.\n` +
    `• \`/airdrop @username 50\` — Send 50 WIFH to a user.\n` +
    `• \`/airdrop @username $10\` — Send $10 worth of WIFH.\n` +
    `• \`/tsend 10 wifh @username\` — Send from treasury.\n` +
    `• \`/tswap 10 eth wifh\` — Swap treasury funds.\n` +
    `• \`/tbuy 0.1\` — Buy WIFH with 0.1 ETH from treasury.\n` +
    `• \`/tsell 100\` — Sell 100 WIFH from treasury.\n\n` +
    `🔑 *Keyword Rewards:*\n` +
    `• \`/keywords\` — List all active keywords.\n` +
    `• \`/addkeyword hello 10\` — Reward 10 pts for saying "hello".\n` +
    `• \`/removekeyword hello\` — Delete the "hello" keyword.\n` +
    `• \`/clearallkeywords\` — Delete all keywords at once.\n\n` +
    `⭐ *Paw Points:*\n` +
    `• \`/addpoints @username 100\` — Give 100 points.\n` +
    `• \`/resetpoints @username\` — Reset one user's points to 0.\n` +
    `• \`/resetallpoints\` — Clear points for ALL users (leaderboard reset).`;

    return ctx.reply(helpText, { parse_mode: 'Markdown' });
});

bot.command('migrate_wallets', async (ctx) => {
    const senderId = ctx.from?.id;
    if (!senderId || !isSuperAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized.');

    const statusMsg = await ctx.reply('\u23F3 Fetching all wallets for migration...');
    const { data: wallets, error: fetchErr } = await supabase.from('user_wallets').select('*');
    if (fetchErr || !wallets) return ctx.reply(`\u274C Error fetching wallets: ${fetchErr?.message}`);

    let successCount = 0;
    let failCount = 0;
    let failErrors: string[] = [];

    for (const wallet of wallets) {
        if (wallet.encryption_iv && wallet.encryption_auth_tag) continue; // Already migrated
        if (!wallet.encrypted_private_key || !wallet.encrypted_private_key.includes(':')) continue; // Unknown format

        try {
            // Decrypt using legacy method
            const privateKey = decryptPrivateKey(wallet);
            
            // Encrypt using new method
            const { encryptedData, iv, authTag } = encryptPrivateKey(privateKey);

            // Update in DB
            const { error: updateErr } = await supabase.from('user_wallets').update({
                encrypted_private_key: encryptedData,
                encryption_iv: iv,
                encryption_auth_tag: authTag
            }).eq('telegram_id', wallet.telegram_id);

            if (updateErr) throw updateErr;
            successCount++;
        } catch (err: any) {
            console.error('Migration failed for user', wallet.telegram_id, err);
            failCount++;
            failErrors.push(`User ${wallet.telegram_id}: ${err.message}`);
        }
    }

    return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `\u2705 **Migration Complete**\n\nSuccessfully migrated: ${successCount}\nFailed: ${failCount}\n\nErrors:\n${failErrors.join('\n')}`
    );
});

bot.command('makeadmin', async (ctx) => {
    const senderId = ctx.from?.id;

    if (!senderId || !isSuperAdmin(senderId)) {
        return ctx.reply("\u274C You are not authorized to use this command. Only the core project admin can promote users.");
    }

    const messageText = ctx.message?.text || '';
    const targetUsername = messageText.split(' ')[1]?.replace('@', '');

    if (!targetUsername) {
        return ctx.reply("\u26A0\uFE0F Please provide a username. Example: /makeadmin @username");
    }

    const { data: userData, error } = await supabase
        .from('users')
        .select('telegram_id')
        .ilike('username', targetUsername)
        .single();

    if (error || !userData) {
        return ctx.reply(`\u274C Could not find a user with the handle @${targetUsername}. Make sure they have started the bot (/start) at least once!`);
    }

    const { error: adminError } = await supabase
        .from('admins')
        .upsert({ telegram_id: userData.telegram_id, username: targetUsername });

    if (adminError) {
        return ctx.reply(`\u274C Failed to grant admin privileges in the database. (Make sure the 'admins' table exists). Details: ${adminError.message}`);
    }
    
    // Add to memory immediately so it works without restarting
    dynamicAdmins.add(userData.telegram_id.toString());

    await ctx.reply(`\u2705 Success! @${targetUsername} has been granted admin privileges.`);
});

bot.command('admin', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized. This command is restricted to project administrators.');

  const adminKeyboard: any[] = [
    [
      { text: "\u{1F3E6} View Treasury", callback_data: "admin_treasury" },
      { text: "\u{1FA82} Airdrop Token", callback_data: "admin_airdrop" }
    ],
    [
      { text: "\u2699\uFE0F Reset Points", callback_data: "admin_reset" },
      { text: "\u{1F511} Keywords", callback_data: "admin_keywords" }
    ]
  ];
  
  if (ctx.chat.type === 'private') {
    adminKeyboard.push([
      { text: "\u2753 Help Guide", callback_data: "admin_help" },
      { text: "\u{1F4B3} My Personal Wallet", callback_data: "action_my_wallet" }
    ]);
  } else {
    adminKeyboard.push([
      { text: "\u2753 Help Guide", callback_data: "admin_help" },
      { text: "\u{1F4B3} My Personal Wallet", callback_data: "action_my_wallet" }
    ]);
  }

  return ctx.reply("\u{1F6E1}\uFE0F *WifhPaws Admin Control Center*\n\nSelect an option below:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: adminKeyboard }
  });
});

bot.command('treasury', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized. Project treasury details are restricted to admins.');
  if (!treasurySigner) return ctx.reply('\u274C Project Treasury wallet is not configured. Check your `TREASURY_PRIVATE_KEY` environment variable.');

  try {
    const treasuryAddress = treasurySigner.address;
    const ethBalanceWei = await provider.getBalance(treasuryAddress);
    const ethBalance = ethers.formatEther(ethBalanceWei);
    let wifhBalance = '0.0';
    if (WIFH_CONTRACT_ADDRESS) {
      try {
        const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
        const rawBalance = await tokenContract.balanceOf(treasuryAddress);
        const decimals = await tokenContract.decimals();
        wifhBalance = ethers.formatUnits(rawBalance, decimals);
      } catch (e) {
        wifhBalance = '0.0';
      }
    }
    const treasuryText = `\u{1F3E6} *Project Treasury Dashboard*\n\n\u{1F4CD} *Treasury Address:*\n\`${treasuryAddress}\`\n\n\u{1F4B0} *Central Reserves (Robinhood Chain):*\n\u2022 *ETH (Gas):* \`${parseFloat(ethBalance).toFixed(4)} ETH\`\n\u2022 *WIFH Pool:* \`${wifhBalance}\` WIFH\n\n\u{1F381} *Quick Airdrop Syntax:*\n\`/airdrop [@username or 0xAddress] [amount]\``;
    return ctx.replyWithMarkdownV2(treasuryText.replace(/([-_ *\[\]().~`>#+=|{}.!])/g, '\\$1'));
  } catch (err: any) {
    return ctx.reply(`\u274C Error loading treasury details: ${err.message}`);
  }
});

bot.command('airdrop', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdmin(senderId)) return ctx.reply('\u26D4 Unauthorized. Only project admins can trigger token airdrops.');
  if (!treasurySigner) return ctx.reply('\u274C Project Treasury wallet is not configured. Add `TREASURY_PRIVATE_KEY` to Render environment variables.');
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 3) {
    return ctx.reply('\u26A0\uFE0F *Admin Airdrop Usage:* `/airdrop [@username or 0xAddress] [amount or $dollarAmount]`\n\n*Examples:*\n\u2022 `/airdrop @username $10` (Airdrop $10 worth of WIFH)\n\u2022 `/airdrop @username 500` (Airdrop 500 WIFH tokens)', { parse_mode: 'Markdown' });
  }
  const targetInput: string = String(args[1] || '');
  let rawAmountStr = args[2].trim();
  let isDollar = rawAmountStr.includes('$');
  let rawValue = parseFloat(rawAmountStr.replace('$', ''));

  if (isNaN(rawValue) || rawValue <= 0) return ctx.reply('\u274C Invalid airdrop amount.');

  try {
    let tokenAmount = rawValue;
    if (isDollar) {
      tokenAmount = Math.round(rawValue * 8000);
    }

    let destinationAddress = '';
    if ((ethers.isAddress as any)(targetInput)) {
      destinationAddress = targetInput;
    } else {
      const targetUser = await getTargetUser(ctx);
      if (!targetUser) return ctx.reply('\u274C Target user not found.');
      const wallet = await getOrCreateWallet(targetUser.id);
      destinationAddress = wallet.public_address;
    }
    const statusMsg = await ctx.reply('\u23F3 Executing Treasury Airdrop on Robinhood Chain...');
    const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
    const decimals = await contract.decimals();
    const tx = await contract.transfer(destinationAddress, ethers.parseUnits(tokenAmount.toString(), decimals));
    await tx.wait();
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `\u{1F389} *AIRDROP SUCCESSFUL!*\n\n\u{1F381} *Amount:* \`${tokenAmount} WIFH\`${isDollar ? ` _(~$${rawValue.toFixed(2)} USD)_` : ''}\n\u{1F4CD} *Recipient:* \`${destinationAddress}\`\n\u{1F517} *Tx Hash:* \`${tx.hash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`\u274C Airdrop failed: ${err.message}`);
  }
});

// ==========================================
// PUBLIC & ADMIN CONTROL COMMANDS
// ==========================================

bot.command('leaderboard', async (ctx) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('username, telegram_id, points')
    .order('points', { ascending: false })
    .gt('points', 0)
    .limit(10);
  if (error || !users || users.length === 0) return ctx.reply('\u{1F3C6} No leaderboard data available yet.');
  let text = '\u{1F3C6} *WifhPaws Top 10 Leaderboard*\n\n';
  users.forEach((user, index) => {
    const name = user.username ? `@${user.username}` : `User ${user.telegram_id}`;
    text += `${index + 1}. ${name} \u2014 *${user.points} pts*\n`;
  });
  return ctx.replyWithMarkdownV2(text.replace(/([-_ *\[\]().~`>#+=|{}.!])/g, '\\$1'));
});

bot.command('addpoints', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const args = ctx.message.text.split(' ').filter(Boolean);
  const amount = parseInt(args[args.length - 1], 10);
  if (isNaN(amount)) return ctx.reply('\u26A0\uFE0F Usage: `/addpoints [amount]` or `/addpoints @username [amount]`');
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('\u274C User not found.');
  const { data: user } = await supabase.from('users').select('points').eq('telegram_id', targetUser.id).single();
  const newBalance = (user?.points || 0) + amount;
  await supabase.from('users').upsert({ telegram_id: targetUser.id, points: newBalance }, { onConflict: 'telegram_id' });
  return ctx.reply(`\u{1F389} Added ${amount} Paw Points to${targetUser.username ? ' @' + targetUser.username : ' ' + targetUser.id}. New Balance: ${newBalance}`);
});

bot.command('resetpoints', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('\u26A0\uFE0F Usage: `/resetpoints @username`');
  await supabase.from('users').upsert({ telegram_id: targetUser.id, points: 0 }, { onConflict: 'telegram_id' });
  return ctx.reply(`\u{1F504} Reset Paw Points to 0 for${targetUser.username ? ' @' + targetUser.username : ' ' + targetUser.id}.`);
});

bot.command('resetallpoints', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const { error } = await supabase.from('users').update({ points: 0 }).neq('telegram_id', 0);
  if (error) return ctx.reply(`\u274C Failed to reset points: ${error.message}`);
  return ctx.reply('\u{1F504} Success! All user point balances have been reset to 0.');
});

bot.command('addkeyword', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('\u26A0\uFE0F Usage: `/addkeyword [word or phrase] [points]`');
  
  const pointsStr = args.pop() || '';
  const points = parseInt(pointsStr, 10);
  const keyword = args.join(' ').toLowerCase().trim();
  
  if (isNaN(points) || points <= 0) return ctx.reply('\u274C Points must be a positive number. Example: `/addkeyword good morning 15`');
  
  const { error } = await supabase.from('dynamic_keywords').upsert({ keyword, points_reward: points }, { onConflict: 'keyword' });
  if (error) return ctx.reply(`\u274C Failed to add keyword: ${error.message}`);
  return ctx.reply(`\u2705 Secret keyword "${keyword}" added with a reward of ${points} Paw Points!`);
});

bot.command('removekeyword', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('\u26A0\uFE0F Usage: `/removekeyword [word]`');
  const keyword = args[0].toLowerCase().trim();
  const { error } = await supabase.from('dynamic_keywords').delete().eq('keyword', keyword);
  if (error) return ctx.reply(`\u274C Failed to delete keyword: ${error.message}`);
  return ctx.reply(`\u{1F5D1}\uFE0F Keyword "${keyword}" removed.`);
});

bot.command('clearallkeywords', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const { error } = await supabase.from('dynamic_keywords').delete().neq('keyword', '');
  if (error) return ctx.reply(`\u274C Failed to clear keywords: ${error.message}`);
  return ctx.reply('\u{1F5D1}\uFE0F All secret keywords have been removed.');
});

bot.command('keywords', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('\u{1F916} Keep guessing! Active secret keywords are hidden from public view.');
  }
  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');
  if (!keywords || keywords.length === 0) return ctx.reply('\u2139\uFE0F No custom rewarded keywords registered.');
  let text = '\u{1F511} *Active Secret Keywords (Admin View):*\n\n';
  keywords.forEach((k) => {
    text += `\u2022 \`${k.keyword}\`: +${k.points_reward} Paw Points\n`;
  });
  return ctx.replyWithMarkdownV2(text.replace(/([-_ *\[\]().~`>#+=|{}.!])/g, '\\$1'));
});

bot.command('addtrigger', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const full = ctx.message.text.replace('/addtrigger', '').trim();
  const separator = full.indexOf('|');
  if (separator === -1) return ctx.reply('\u26A0\uFE0F Usage: `/addtrigger keyword | Bot response here`', { parse_mode: 'Markdown' });
  const keyword = full.slice(0, separator).trim().toLowerCase();
  const response = full.slice(separator + 1).trim();
  if (!keyword || !response) return ctx.reply('\u274C Both keyword and response are required.');
  const { error } = await supabase.from('chat_triggers').upsert({ keyword, response }, { onConflict: 'keyword' });
  if (error) return ctx.reply(`\u274C Failed: ${error.message}`);
  refreshTriggerCache(); // immediate cache update
  return ctx.reply(`\u2705 Trigger added!\n\n*When someone says:* \`${keyword}\`\n*Bot replies:* ${response}`, { parse_mode: 'Markdown' });
});

bot.command('removetrigger', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const keyword = ctx.message.text.replace('/removetrigger', '').trim().toLowerCase();
  if (!keyword) return ctx.reply('\u26A0\uFE0F Usage: `/removetrigger keyword`', { parse_mode: 'Markdown' });
  const { error } = await supabase.from('chat_triggers').delete().eq('keyword', keyword);
  if (error) return ctx.reply(`\u274C Failed: ${error.message}`);
  refreshTriggerCache(); // immediate cache update
  return ctx.reply(`\u{1F5D1}\uFE0F Trigger for \`${keyword}\` removed.`, { parse_mode: 'Markdown' });
});

bot.command('listtriggers', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const { data: triggers } = await supabase.from('chat_triggers').select('keyword, response');
  if (!triggers || triggers.length === 0) return ctx.reply('\u2139\uFE0F No custom chat triggers set.');
  let text = '\u{1F4AC} *Active Chat Triggers:*\n\n';
  triggers.forEach((t, i) => { text += `${i + 1}. \`${t.keyword}\` \u2192 _${t.response}_\n`; });
  return ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('cleartriggers', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('\u26D4 Unauthorized.');
  const { error } = await supabase.from('chat_triggers').delete().neq('keyword', '');
  if (error) return ctx.reply(`\u274C Failed: ${error.message}`);
  refreshTriggerCache(); // immediate cache update
  return ctx.reply('\u{1F5D1}\uFE0F All custom chat triggers cleared.');
});

// ==========================================
// CHAT TRIGGERS (Auto-replies)
// ==========================================
const HARDCODED_TRIGGERS: Record<string, string> = {
  'wen lambo': '🐾 Patience, paw-some friend! Focus on the mission, not the lambo!',
  'roadmap': '📌 Check our pinned messages for the full WifhPaws ecosystem roadmap!',
  'wen moon': '🌕 We\'re already on the launchpad — stay tuned!',
  'rug': '🛡️ WifhPaws is community-driven and transparent. No rugs here!',
};

// Chat Message Listener — checks triggers then awards paw points
bot.on('message', async (ctx, next) => {
  const message = ctx.message as any;
  if (!message || !message.text || message.text.startsWith('/') || ctx.from?.is_bot) return next();

  const text = message.text.toLowerCase();
  const isPrivate = ctx.chat.type === 'private';

  // 1. Check hardcoded triggers (work in both group and private)
  for (const [keyword, response] of Object.entries(HARDCODED_TRIGGERS)) {
    if (text.includes(keyword)) {
      return ctx.reply(response);
    }
  }

  // 2. Check cached DB triggers (auto-reply, no points, works in group and private)
  for (const trigger of cachedChatTriggers) {
    if (text.includes(trigger.keyword.toLowerCase())) {
      return ctx.reply(trigger.response);
    }
  }

  // 3. Paw-point keywords
  const matchedKeyword = cachedPointKeywords.find((k) => text.includes(k.keyword.toLowerCase()));
  if (!matchedKeyword) return next();

  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const { data: user } = await supabase.from('users').select('points, last_awarded_at').eq('telegram_id', userId).single();
  const now = new Date();
  if (user?.last_awarded_at) {
    const lastAwarded = new Date(user.last_awarded_at);
    if ((now.getTime() - lastAwarded.getTime()) / 1000 < COOLDOWN_SECONDS) return next();
  }
  const currentPoints = user?.points || 0;
  const newBalance = currentPoints + matchedKeyword.points_reward;
  await supabase.from('users').upsert(
    { telegram_id: userId, username, points: newBalance, last_awarded_at: now.toISOString() },
    { onConflict: 'telegram_id' }
  );
  // Show points earned
  await ctx.reply(`🐾 +${matchedKeyword.points_reward} Paw Points awarded to ${username ? '@' + username : 'you'}! Total: ${newBalance}`);
  return next();
});

// ==========================================
// LIGHTWEIGHT HTTP SERVER FOR RENDER / 24/7 & WEBAPP
// ==========================================
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        bot: 'WifhPaws',
        timestamp: new Date().toISOString(),
      })
    );
  } else if (req.url === '/admin' || req.url?.startsWith('/admin?')) {
    const adminPath = path.join(process.cwd(), 'admin.html');
    if (fs.existsSync(adminPath)) {
      let html = fs.readFileSync(adminPath, 'utf8');
      // Inject runtime Supabase credentials
      html = html
        .replace('__SUPABASE_URL__', process.env.SUPABASE_URL || '')
        .replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404); res.end('Admin panel not found.');
    }
  } else if (req.url?.startsWith('/api/refresh-cache')) {
    (async () => {
      await refreshTriggerCache();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    })();
  } else if (req.url?.startsWith('/api/is-admin')) {
    (async () => {
      try {
        const urlObj = new URL(req.url!, `http://${req.headers.host || 'localhost'}`);
        const telegramId = Number(urlObj.searchParams.get('telegram_id'));
        const adminCheck = telegramId > 0 && await isAdmin(telegramId);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ is_admin: adminCheck }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ is_admin: false }));
      }
    })();
  } else if (req.url === '/' || req.url?.startsWith('/?') || req.url?.startsWith('/index.html')) {
    const indexPath = path.join(process.cwd(), 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(indexPath));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', bot: 'WifhPaws' }));
    }
  } else if (req.url?.startsWith('/api/balance')) {
    (async () => {
      try {
        const urlObj = new URL(req.url!, `http://${req.headers.host || 'localhost'}`);
        const telegramId = Number(urlObj.searchParams.get('telegram_id'));
        const mode = urlObj.searchParams.get('mode');

        if (!telegramId) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ success: false, error: 'Missing or invalid telegram_id' }));
        }

        let address = '';
        if (mode === 'treasury') {
          if (!isAdmin(telegramId)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ success: false, error: 'Unauthorized. Admins only.' }));
          }
          if (!treasurySigner) throw new Error('Treasury not configured');
          address = treasurySigner.address;
        } else {
          const wallet = await getOrCreateWallet(telegramId);
          address = wallet.public_address;
        }

        let ethBalance = '0.0000';
        try {
          const ethBalanceWei = await provider.getBalance(address);
          ethBalance = parseFloat(ethers.formatEther(ethBalanceWei)).toFixed(4);
        } catch (e: any) {
          console.warn('RPC ETH balance error:', e.message);
        }

        let wifhBalance = '0.0';
        if (WIFH_CONTRACT_ADDRESS) {
          try {
            const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
            const rawBalance = await tokenContract.balanceOf(address);
            const decimals = await tokenContract.decimals();
            wifhBalance = ethers.formatUnits(rawBalance, decimals);
          } catch (e) {
            wifhBalance = '0.0';
          }
        }

        const ethPrice = await getEthPriceUsd();
        const poolRate = await getPoolRate();
        const wifhPriceUsd = (ethPrice / poolRate).toFixed(8);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(
          JSON.stringify({
            success: true,
            address: address,
            eth_balance: ethBalance,
            wifh_balance: wifhBalance,
            eth_price_usd: ethPrice,
            wifh_price_usd: wifhPriceUsd,
            pool_rate: poolRate,
          })
        );
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    })();
  } else if (req.url === '/api/swap' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const telegramId = Number(payload.telegram_id);
        const mode = payload.mode;
        const fromToken = String(payload.from || '').toLowerCase();
        const toToken = String(payload.to || '').toLowerCase();
        const amount = Number(payload.amount);

        if (!telegramId || !amount || amount <= 0 || !['wifh', 'eth'].includes(fromToken) || !['wifh', 'eth'].includes(toToken)) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid swap payload parameters' }));
        }

        let result;
        if (mode === 'treasury') {
          if (!isAdmin(telegramId)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ success: false, error: 'Unauthorized. Admins only.' }));
          }
          if (!treasurySigner) throw new Error('Treasury not configured');
          result = await executeOnChainSwap(null, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount, treasurySigner);
        } else {
          const userWallet = await getOrCreateWallet(telegramId);
          result = await executeOnChainSwap(userWallet, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount);
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, received: result.received, received_usd: result.receivedUsd, tx_hash: result.txHash }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.url?.startsWith('/public/')) {
    const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(process.cwd(), safePath);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.gif') contentType = 'image/gif';
      
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(port, () => {
  console.log(`Server listening on port ${port} (Serving Dashboard & /health)`);
});

// Launch Bot
bot.launch().then(() => {
  console.log('WifhPaws Bot running with secret keywords, treasury dashboard, and WebApp!');
  bot.telegram.setMyCommands([
    { command: 'wallet', description: 'Open your Personal Wallet Dashboard' },
    { command: 'leaderboard', description: 'View the top Paw Point holders' },
    { command: 'swap', description: 'Swap between WIFH and ETH' },
    { command: 'send', description: 'Send tokens to someone' },
    { command: 'buy', description: 'Buy WIFH with ETH' },
    { command: 'sell', description: 'Sell WIFH for ETH' },
    { command: 'admin', description: 'Open Admin Control Center (Admins)' }
  ]).catch(err => console.error('Failed to set commands menu:', err));
});
const stopBot = (signal: string) => {
  console.log(`\nReceived ${signal}. Stopping bot...`);
  server.close();
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
