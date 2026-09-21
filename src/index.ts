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
const WEBAPP_URL = process.env.WEBAPP_URL?.trim() || 'https://wifhpaws-bot.onrender.com/';

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY || !WALLET_ENCRYPTION_KEY) {
  throw new Error('Missing required environment variables in .env file.');
}

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err: any, ctx) => {
  console.error(`Telegram error in ${ctx.updateType}:`, err?.message || err);
});
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL);

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
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = crypto.scryptSync(WALLET_ENCRYPTION_KEY!, 'salt', 32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
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
  userWallet: { public_address: string; encrypted_private_key: string },
  fromToken: 'eth' | 'wifh',
  toToken: 'eth' | 'wifh',
  amount: number
): Promise<{ txHash: string; received: string; receivedUsd: string }> {
  if (!DEX_ROUTER_ADDRESS || !WIFH_CONTRACT_ADDRESS) {
    throw new Error('DEX router or WIFH contract address is not configured.');
  }

  const privateKey = decryptPrivateKey(userWallet.encrypted_private_key);
  const signer = new ethers.Wallet(privateKey, provider);
  const routerContract = new ethers.Contract(DEX_ROUTER_ADDRESS, UNISWAP_V3_ROUTER_ABI, signer);
  const ethPrice = await getEthPriceUsd();
  const poolRate = await getPoolRate();
  const wifhPrice = ethPrice / poolRate;

  let txHash = '';
  let received = '0';
  let receivedUsd = '0.00';

  if (fromToken === 'eth') {
    const ethValWei = ethers.parseEther(amount.toFixed(18));
    const userEthBal = await provider.getBalance(userWallet.public_address);
    if (userEthBal < ethValWei) {
      throw new Error(`Insufficient ETH balance. You have ${parseFloat(ethers.formatEther(userEthBal)).toFixed(6)} ETH but need ${amount.toFixed(6)} ETH.`);
    }

    const params = {
      tokenIn: WETH_ADDRESS,
      tokenOut: WIFH_CONTRACT_ADDRESS,
      fee: 10000,
      recipient: userWallet.public_address,
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

    const userWifhBal = await wifhContract.balanceOf(userWallet.public_address);
    if (userWifhBal < wifhAmountWei) {
      throw new Error(`Insufficient WIFH balance. You have ${ethers.formatUnits(userWifhBal, decimals)} WIFH but need ${amount} WIFH.`);
    }

    const currentAllowance = await wifhContract.allowance(userWallet.public_address, DEX_ROUTER_ADDRESS);
    if (currentAllowance < wifhAmountWei) {
      const appTx = await wifhContract.approve(DEX_ROUTER_ADDRESS, ethers.MaxUint256, { gasLimit: 100000n });
      await appTx.wait();
    }

    const params = {
      tokenIn: WIFH_CONTRACT_ADDRESS,
      tokenOut: WETH_ADDRESS,
      fee: 10000,
      recipient: userWallet.public_address,
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
        { text: "\u{1F4B3} My Personal Wallet", callback_data: "action_my_wallet" }
      ]
    ];
    return ctx.reply("\u{1F43E} *WifhPaws Admin & Treasury Control*", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: adminKeyboard }
    });
  } else {
    // Regular user private chat: show wallet dashboard
    return sendWalletDashboard(ctx, userId!);
  }
});

async function sendWalletDashboard(ctx: any, telegramId: number, edit: boolean = false) {
  try {
    const wallet = await getOrCreateWallet(telegramId);
    let ethBalance = '0.0000';
    try {
      const ethBalanceWei = await provider.getBalance(wallet.public_address);
      ethBalance = parseFloat(ethers.formatEther(ethBalanceWei)).toFixed(4);
    } catch (e: any) {
      console.warn('RPC ETH balance error:', e.message);
    }

    let wifhBalance = '0.0';
    if (WIFH_CONTRACT_ADDRESS) {
      try {
        const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
        const rawBalance = await tokenContract.balanceOf(wallet.public_address);
        const decimals = await tokenContract.decimals();
        wifhBalance = ethers.formatUnits(rawBalance, decimals);
      } catch (e) {
        wifhBalance = '0.0';
      }
    }

    const messageText = `\u{1F43E} *WifhPaws Wallet Dashboard*\n\n\u{1F4CD} *Address:*\n\`${wallet.public_address}\`\n\n\u{1F4B0} *Balances (Robinhood Chain):*\n\u2022 *ETH (Gas):* \`${ethBalance} ETH\`\n\u2022 *WIFH Token:* \`${wifhBalance}\`\n\nChoose an option below:`;

    const keyboard: any[] = [
      [{ text: '\u{1F680} Launch Mini App Dashboard', web_app: { url: WEBAPP_URL } }],
      [{ text: '\u{1F4E5} Receive', callback_data: 'action_receive' }, { text: '\u{1F4B8} Send', callback_data: 'action_send_guide' }],
      [{ text: '\u{1F504} Swap Tokens', callback_data: 'action_swap' }, { text: '\u{1F512} Export Private Key', callback_data: 'action_export_key' }]
    ];

    if (isAdmin(telegramId)) {
      keyboard.push([{ text: '\u{1F6E1}\uFE0F Open Admin Panel', callback_data: 'action_open_admin' }]);
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
    return ctx.reply(`\u274C Error accessing wallet: ${err.message}`);
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
const BACK_TO_WALLET = [[{ text: '\u2B05\uFE0F Back to Wallet', callback_data: 'action_my_wallet' }]];
const BACK_TO_ADMIN = [[{ text: '\u2B05\uFE0F Back to Admin Panel', callback_data: 'action_open_admin' }]];

bot.action('action_receive', async (ctx) => {
  await ctx.answerCbQuery();
  const wallet = await getOrCreateWallet(ctx.from.id);
  return ctx.reply(
    `\u{1F4E5} *Deposit Funds*\n\nSend ETH or WIFH on *Robinhood Chain* to your address below:\n\n\`${wallet.public_address}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
  );
});

bot.action('action_send_guide', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    `\u{1F4B8} *How to Send Funds*\n\nUse the \`/send\` command in private chat:\n\n\u2022 *To External Wallet:*\n\`/send [amount] [eth/wifh] [0xAddress]\`\n\n\u2022 *To Telegram User:*\n\`/send [amount] [eth/wifh] [@username]\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
  );
});

bot.action('action_swap', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    `\u{1F504} *Token Swap Guide*\n\n` +
    `Swap WIFH and ETH instantly using the command:\n\n` +
    `\u2022 *Swap WIFH for ETH:*\n\`/swap [amount] wifh eth\`\n_Example:_ \`/swap 100 wifh eth\`\n\n` +
    `\u2022 *Swap ETH for WIFH:*\n\`/swap [amount] eth wifh\`\n_Example:_ \`/swap 0.01 eth wifh\`\n\n` +
    `\u{1F4A1} *Tip:* You can also launch the Mini App for a visual Swap interface!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
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
    const privateKey = decryptPrivateKey(wallet.encrypted_private_key);
    return ctx.reply(
      `\u26A0\uFE0F *CONFIDENTIAL PRIVATE KEY*\n\nDo not share this key with anyone!\n\n\u{1F511} \`${privateKey}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_WALLET } }
    );
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
  return ctx.reply(
    `\u{1F511} *Secret Keyword Controls:*\n\n` +
    `\u2022 \`/addkeyword [word or phrase] [points]\` \u2014 Create a hidden chat trigger\n` +
    `\u2022 \`/removekeyword [word]\` \u2014 Delete an existing keyword\n` +
    `\u2022 \`/clearallkeywords\` \u2014 Delete all keywords at once\n` +
    `\u2022 \`/keywords\` \u2014 View all active hidden keywords`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_ADMIN } }
  );
});

bot.action('action_my_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.chat?.type !== 'private') {
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
      { text: "\u2753 Help Guide", callback_data: "admin_help" },
      { text: "\u{1F4B3} My Personal Wallet", callback_data: "action_my_wallet" }
    ]
  ];

  return ctx.reply("\u{1F6E1}\uFE0F *WifhPaws Admin Control Center*\n\nSelect an option below:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: adminKeyboard }
  });
});

bot.action('admin_help', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from!.id)) return ctx.reply('\u26D4 Unauthorized.');

  const helpText = `\u{1F6E1}\uFE0F *Admin Commands Cheat Sheet*\n\n` +
    `\u{1F464} *Management:*\n` +
    `\u2022 \`/makeadmin @username\` \u2014 Promote a user to admin.\n` +
    `\u2022 \`/admin\` \u2014 Open the visual Admin Control Center.\n\n` +
    `\u{1F3E6} *Treasury & Tokens:*\n` +
    `\u2022 \`/treasury\` \u2014 View live project treasury balances.\n` +
    `\u2022 \`/airdrop @username 50\` \u2014 Send 50 WIFH to a user.\n` +
    `\u2022 \`/airdrop @username $10\` \u2014 Send $10 worth of WIFH.\n\n` +
    `\u{1F511} *Keyword Rewards:*\n` +
    `\u2022 \`/keywords\` \u2014 List all active keywords.\n` +
    `\u2022 \`/addkeyword hello 10\` \u2014 Reward 10 pts for saying "hello".\n` +
    `\u2022 \`/removekeyword hello\` \u2014 Delete the "hello" keyword.\n` +
    `\u2022 \`/clearallkeywords\` \u2014 Delete all keywords at once.\n\n` +
    `\u2B50 *Paw Points:*\n` +
    `\u2022 \`/addpoints @username 100\` \u2014 Give 100 points.\n` +
    `\u2022 \`/resetpoints @username\` \u2014 Reset one user's points to 0.\n` +
    `\u2022 \`/resetallpoints\` \u2014 Clear points for ALL users (leaderboard reset).`;

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
    const privateKey = decryptPrivateKey(senderData.encrypted_private_key);
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

// ==========================================
// ADMIN HELP & TREASURY COMMANDS
// ==========================================

bot.command('adminhelp', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("\u26D4 Unauthorized.");

    const helpText = `\u{1F6E1}\uFE0F *Admin Commands Cheat Sheet*\n\n` +
      `\u{1F464} *Management:*\n` +
      `\u2022 \`/makeadmin @username\` \u2014 Promote a user to admin.\n` +
      `\u2022 \`/admin\` \u2014 Open the visual Admin Control Center.\n\n` +
      `\u{1F3E6} *Treasury & Tokens:*\n` +
      `\u2022 \`/treasury\` \u2014 View live project treasury balances.\n` +
      `\u2022 \`/airdrop @username 50\` \u2014 Send 50 WIFH to a user.\n` +
      `\u2022 \`/airdrop @username $10\` \u2014 Send $10 worth of WIFH.\n\n` +
      `\u{1F511} *Keyword Rewards:*\n` +
      `\u2022 \`/keywords\` \u2014 List all active keywords.\n` +
      `\u2022 \`/addkeyword hello 10\` \u2014 Reward 10 pts for saying "hello".\n` +
      `\u2022 \`/removekeyword hello\` \u2014 Delete the "hello" keyword.\n` +
      `\u2022 \`/clearallkeywords\` \u2014 Delete all keywords at once.\n\n` +
      `\u2B50 *Paw Points:*\n` +
      `\u2022 \`/addpoints @username 100\` \u2014 Give 100 points.\n` +
      `\u2022 \`/resetpoints @username\` \u2014 Reset one user's points to 0.\n` +
      `\u2022 \`/resetallpoints\` \u2014 Clear points for ALL users (leaderboard reset).`;

    return ctx.reply(helpText, { parse_mode: 'Markdown' });
});

bot.command('makeadmin', async (ctx) => {
    const senderId = ctx.from?.id;

    if (!senderId || !isAdmin(senderId)) {
        return ctx.reply("\u274C You are not authorized to use this command.");
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

// Chat Message Listener for Keyword Rewards
bot.on('message', async (ctx, next) => {
  const message = ctx.message as any;
  if (!message || !message.text || message.text.startsWith('/') || ctx.from?.is_bot) return next();
  // Only award in group chats (not in private DMs with the bot)
  if (ctx.chat.type === 'private') return next();

  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const text = message.text.toLowerCase();
  const { data: keywords } = await supabase.from('dynamic_keywords').select('*');
  if (!keywords || keywords.length === 0) return next();
  const matchedKeyword = keywords.find((k) => text.includes(k.keyword.toLowerCase()));
  if (!matchedKeyword) return next();
  const { data: user } = await supabase.from('users').select('points, last_awarded_at').eq('telegram_id', userId).single();
  const now = new Date();
  if (user?.last_awarded_at) {
    const lastAwarded = new Date(user.last_awarded_at);
    const diffInSeconds = (now.getTime() - lastAwarded.getTime()) / 1000;
    if (diffInSeconds < COOLDOWN_SECONDS) return next();
  }
  const currentPoints = user?.points || 0;
  const newBalance = currentPoints + matchedKeyword.points_reward;
  await supabase.from('users').upsert(
    { telegram_id: userId, username, points: newBalance, last_awarded_at: now.toISOString() },
    { onConflict: 'telegram_id' }
  );
  await ctx.reply(`\u{1F43E} +${matchedKeyword.points_reward} Paw Points awarded to ${username ? '@' + username : 'you'}! Total: ${newBalance}`);
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
  } else if (req.url === '/' || req.url === '/index.html') {
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

        if (!telegramId) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ success: false, error: 'Missing or invalid telegram_id' }));
        }

        const wallet = await getOrCreateWallet(telegramId);
        let ethBalance = '0.0000';
        try {
          const ethBalanceWei = await provider.getBalance(wallet.public_address);
          ethBalance = parseFloat(ethers.formatEther(ethBalanceWei)).toFixed(4);
        } catch (e: any) {
          console.warn('RPC ETH balance error:', e.message);
        }

        let wifhBalance = '0.0';
        if (WIFH_CONTRACT_ADDRESS) {
          try {
            const tokenContract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, provider);
            const rawBalance = await tokenContract.balanceOf(wallet.public_address);
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
            address: wallet.public_address,
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
        const fromToken = String(payload.from || '').toLowerCase();
        const toToken = String(payload.to || '').toLowerCase();
        const amount = Number(payload.amount);

        if (!telegramId || !amount || amount <= 0 || !['wifh', 'eth'].includes(fromToken) || !['wifh', 'eth'].includes(toToken)) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid swap payload parameters' }));
        }

        const userWallet = await getOrCreateWallet(telegramId);
        const result = await executeOnChainSwap(userWallet, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, received: result.received, received_usd: result.receivedUsd, tx_hash: result.txHash }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(port, () => {
  console.log(`Server listening on port ${port} (Serving Dashboard & /health)`);
});

// Launch Bot
bot.launch().then(() => console.log('WifhPaws Bot running with secret keywords, treasury dashboard, and WebApp!'));

const stopBot = (signal: string) => {
  console.log(`\nReceived ${signal}. Stopping bot...`);
  server.close();
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
