import express from 'express';
import fs from 'fs';
import path from 'path';
import { Telegraf, Context, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { getPayoutConfig, setPayoutConfig } from './services/triviaPayoutService';
import {
  getTriviaQuestionsByCategory,
  getActiveTriviaCategory,
  setActiveTriviaCategory,
  TriviaCategory,
} from './services/triviaBankService';
import { calculateAndRouteFee, dispatchFeesToDevWallet, getDevWalletAddress } from './services/feeService';
import { sendDevPanelMenu, setupDevPanelActions, DevPanelDeps } from './services/devPanelService';
import { registerRbacCommands } from './commands/rbacCommands';
import { setupScrambleGame, pendingScrambleWinners, getScramblePayoutConfig, setScramblePayoutConfig } from './services/scrambleGameService';
import { cacheUserMiddleware, checkPermission } from './middleware/rbacGuards';
import {
  isGlobalMaster,
  getProjectByChatId,
  getEffectiveRole,
  hasMinimumRole,
  upsertUserCache,
  hasAnyRbacRole,
  getHighestRoleAcrossProjects,
} from './services/rbacService';

dotenv.config();
const BOT_USERNAME = process.env.BOT_USERNAME || '';

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

// ── RBAC: Cache every user's handle ↔ ID mapping on every interaction ──
bot.use(cacheUserMiddleware);

// ── RBAC: Register all three-tier RBAC commands ──
registerRbacCommands(bot);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Use service role key for server-side reads to bypass RLS
const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
);
const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL);

// ==========================================
// STATE & CACHE
// ==========================================
const onboardingStates = new Map<number, string>();

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

// Dedicated Dev Wallet (receives all fees and revenue streams)
let devSigner: ethers.Wallet | null = null;
if (process.env.DEV_WALLET_PRIVATE_KEY) {
  devSigner = new ethers.Wallet(process.env.DEV_WALLET_PRIVATE_KEY, provider);
  console.log(`[DevWallet] Initialized: ${devSigner.address}`);
} else if (getDevWalletAddress()) {
  console.log(`[DevWallet] Address-only mode: ${getDevWalletAddress()} (read-only, no signing)`);
} else {
  console.warn('[DevWallet] Not configured — fees will fall back to Treasury if set.');
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

  if (existingWallet) {
    // Ensure users.wallet_address is always in sync with user_wallets and record exists in users
    await supabase
      .from('users')
      .upsert({
        telegram_id: telegramId,
        wallet_address: existingWallet.public_address,
        updated_at: new Date().toISOString()
      }, { onConflict: 'telegram_id' });
    return existingWallet;
  }

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

  // Ensure record exists in users table with new wallet address
  await supabase
    .from('users')
    .upsert({
      telegram_id: telegramId,
      wallet_address: newWallet.address,
      updated_at: new Date().toISOString()
    }, { onConflict: 'telegram_id' });

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
  // Tier 0: Global Masters always pass
  if (isGlobalMaster(userId)) return true;
  // Legacy env-based checks
  const adminSingle = process.env.ADMIN_TELEGRAM_ID?.trim();
  const idStr = userId.toString();
  return ADMIN_USER_IDS.includes(idStr) || (adminSingle === idStr) || dynamicAdmins.has(idStr);
}

function isSuperAdmin(userId: number): boolean {
  // Tier 0: Global Masters always pass
  if (isGlobalMaster(userId)) return true;
  // Legacy env-based checks
  const adminSingle = process.env.ADMIN_TELEGRAM_ID?.trim();
  const idStr = userId.toString();
  return ADMIN_USER_IDS.includes(idStr) || (adminSingle === idStr);
}

export async function isModOrHigher(userId: number): Promise<boolean> {
  if (isAdmin(userId)) return true;
  return await hasAnyRbacRole(userId); // Any role is at least Mod
}

async function isSuperAdminOrHigherRBAC(userId: number): Promise<boolean> {
  if (isSuperAdmin(userId)) return true;
  const highest = await getHighestRoleAcrossProjects(userId);
  return highest === 'global_master' || highest === 'project_owner' || highest === 'super_admin';
}

/**
 * RBAC-aware admin check. Checks both the new project-based RBAC system
 * and the legacy env-based admin lists.
 * Returns true if the user has at least `mod` role in the project for this chat,
 * OR if they pass the legacy isAdmin() check.
 */
async function isAdminForChat(chatId: number, userId: number): Promise<boolean> {
  if (isAdmin(userId)) return true;
  return checkPermission(chatId, userId, 'mod');
}

/**
 * RBAC-aware super admin check. Returns true if the user has at least
 * `super_admin` role in the project, OR passes the legacy isSuperAdmin() check.
 */
async function isSuperAdminForChat(chatId: number, userId: number): Promise<boolean> {
  if (isSuperAdmin(userId)) return true;
  return checkPermission(chatId, userId, 'super_admin');
}

/**
 * Resolves a username or numeric ID across all sources:
 * 1. users table
 * 2. telegram_user_cache
 * 3. project_roles table (super admins, mods, project owners)
 * 4. admins table
 * 5. Telegram getChat API
 * Automatically guarantees the resolved user is recorded in public.users.
 */
async function resolveRecipientUser(
  rawInput: string,
  ctx?: Context
): Promise<{ telegram_id: number; username?: string | null } | null> {
  const target = rawInput.replace(/^@/, '').trim();
  if (!target) return null;

  if (/^\d+$/.test(target)) {
    const numericId = Number(target);
    return { telegram_id: numericId };
  }

  // 1. Check users table
  const { data: dbUser } = await supabase
    .from('users')
    .select('telegram_id, username')
    .ilike('username', target)
    .limit(1)
    .maybeSingle();

  if (dbUser) {
    return { telegram_id: dbUser.telegram_id, username: dbUser.username };
  }

  // 2. Check telegram_user_cache
  const { data: cacheUser } = await supabase
    .from('telegram_user_cache')
    .select('telegram_id, username')
    .ilike('username', target)
    .limit(1)
    .maybeSingle();

  if (cacheUser) {
    await supabase.from('users').upsert(
      { telegram_id: cacheUser.telegram_id, username: cacheUser.username, updated_at: new Date().toISOString() },
      { onConflict: 'telegram_id' }
    );
    return { telegram_id: cacheUser.telegram_id, username: cacheUser.username };
  }

  // 3. Check project_roles (super_admin, mod, project_owner)
  const { data: roleUser } = await supabase
    .from('project_roles')
    .select('telegram_id, username')
    .ilike('username', target)
    .limit(1)
    .maybeSingle();

  if (roleUser) {
    await upsertUserCache(roleUser.telegram_id, roleUser.username || target);
    return { telegram_id: roleUser.telegram_id, username: roleUser.username || target };
  }

  // 4. Check admins table
  const { data: adminUser } = await supabase
    .from('admins')
    .select('telegram_id, username')
    .ilike('username', target)
    .limit(1)
    .maybeSingle();

  if (adminUser) {
    await upsertUserCache(adminUser.telegram_id, adminUser.username || target);
    return { telegram_id: adminUser.telegram_id, username: adminUser.username || target };
  }

  // 5. Telegram getChat API fallback
  if (ctx && ctx.telegram) {
    try {
      const chatInfo = await ctx.telegram.getChat('@' + target);
      if (chatInfo && 'id' in chatInfo) {
        const uId = chatInfo.id;
        const uName = ('username' in chatInfo && chatInfo.username) ? chatInfo.username : target;
        await upsertUserCache(
          uId,
          uName,
          ('first_name' in chatInfo && chatInfo.first_name) ? chatInfo.first_name : null,
          ('last_name' in chatInfo && chatInfo.last_name) ? chatInfo.last_name : null
        );
        return { telegram_id: uId, username: uName };
      }
    } catch {
      // Chat not accessible via API
    }
  }

  return null;
}

async function getTargetUser(ctx: Context, fallbackInput?: string): Promise<{ id: number; username?: string } | null> {
  const message = ctx.message as any;
  if (!message) return null;

  if (message.reply_to_message?.from) {
    const from = message.reply_to_message.from;
    await upsertUserCache(from.id, from.username || null, from.first_name || null, from.last_name || null);
    return {
      id: from.id,
      username: from.username,
    };
  }

  // Check text_mention entities
  const entities = message.entities || [];
  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user) {
      const u = entity.user;
      await upsertUserCache(u.id, u.username || null, u.first_name || null, u.last_name || null);
      return { id: u.id, username: u.username };
    }
  }

  let targetArg = fallbackInput?.trim();
  if (!targetArg && message.text) {
    const args = message.text.trim().split(/\s+/).slice(1);
    if (args.length > 0) {
      targetArg = args[0];
    }
  }

  if (targetArg) {
    const resolved = await resolveRecipientUser(targetArg, ctx);
    if (resolved) {
      return { id: resolved.telegram_id, username: resolved.username || undefined };
    }
  }

  return null;
}

// ==========================================
// WELCOME & USER INTERACTION COMMANDS
// ==========================================

bot.command(['start', `start@${BOT_USERNAME}`], async (ctx) => {
  const userId = ctx.from?.id;

  // Auto-register and pre-provision wallet for any user running /start
  if (userId && ctx.from && !ctx.from.is_bot) {
    upsertUserCache(
      userId,
      ctx.from.username || null,
      ctx.from.first_name || null,
      ctx.from.last_name || null
    ).catch(() => {});
    getOrCreateWallet(userId).catch(() => {});
  }

  const message = ctx.message as any;
  const args = message?.text?.split(/\s+/)[1];

  if (args === 'wallet' && ctx.chat.type === 'private') {
    return sendWalletDashboard(ctx, ctx.from.id);
  }

  if (args === 'onboarding' && ctx.chat.type === 'private') {
    return sendOnboardingMenu(ctx);
  }

  if (args === 'devpanel' && ctx.chat.type === 'private') {
    if (userId && DEV_PANEL_ALLOWED_IDS.includes(userId)) {
      return sendDevPanelMenu(ctx, devPanelDeps);
    }
    return ctx.reply('⛔ Unauthorized.');
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

  if (userId && DEV_PANEL_ALLOWED_IDS.includes(userId)) {
    // If you want Dev Panel on /start for these users:
    // return sendDevPanelMenu(ctx, devPanelDeps);
    // OR just show wallet, they can use /devpanel
  }

  // Fetch user to check onboarding status
  const { data: user } = await supabase
    .from('users')
    .select('onboarded_at')
    .eq('telegram_id', userId)
    .single();

  if (user && user.onboarded_at) {
    // Regular private chat: show wallet dashboard
    return sendWalletDashboard(ctx, userId!);
  } else {
    // Show the onboarding menu for new/un-onboarded users
    return sendOnboardingMenu(ctx);
  }
});

bot.on('new_chat_members', async (ctx) => {
  const newMembers = ctx.message.new_chat_members;
  for (const member of newMembers) {
    if (!member.is_bot) {
      // 1. Immediately cache user in telegram_user_cache & public.users
      upsertUserCache(
        member.id,
        member.username || null,
        member.first_name || null,
        member.last_name || null
      ).catch(() => {});

      // 2. Pre-provision custodial wallet so user is ready for airdrops & rewards
      getOrCreateWallet(member.id).catch(() => {});

      const usernameStr = member.username ? `@${member.username}` : member.first_name;
      try {
        const msg = await ctx.reply(
          `Welcome ${usernameStr}! Check your DMs to set up your wallet for trivia payouts & raid points 🐾`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🚀 Start Onboarding & Link Wallet', url: `https://t.me/${ctx.botInfo.username}?start=onboarding` }]
              ]
            }
          }
        );
        setTimeout(() => {
          ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
        }, 60000);
      } catch (e: any) {
        console.error('Failed to send welcome message:', e.message);
      }
      
      // 3. Mark welcome_sent in public.users via upsert
      try {
        await supabase.from('users').upsert({
          telegram_id: member.id,
          username: member.username?.toLowerCase() || null,
          welcome_sent: true,
          updated_at: new Date().toISOString()
        }, { onConflict: 'telegram_id' });
      } catch (e: any) {
        console.error('Failed to update welcome_sent:', e.message);
      }
    }
  }
});

async function sendOnboardingMenu(ctx: any) {
  const keyboard = [
    [{ text: '👛 Link Wallet', callback_data: 'onboard_wallet' }],
    [{ text: '🎮 How Trivia Works', callback_data: 'onboard_trivia' }],
    [{ text: '⚔️ How Raids Work', callback_data: 'onboard_raids' }]
  ];
  const text = `🐾 *Welcome to WifhPaws!*\nGet set up to participate in community activities and earn rewards:`;
  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } else {
    return ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }
}

bot.action('onboard_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  onboardingStates.set(ctx.from.id, 'AWAITING_WALLET_INPUT');
  return ctx.reply("Please send your Robinhood Chain address (0x...) to link your account for trivia payouts and holder rewards.");
});

bot.action('onboard_trivia', async (ctx) => {
  await ctx.answerCbQuery();
  const text = `🎮 *How Trivia Works*\n\nTrivia games run in group chats. Top 3 winners receive automatic payouts to their linked wallets!\nMake sure you linked your wallet.`;
  return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'onboard_back' }]] } });
});

bot.action('onboard_raids', async (ctx) => {
  await ctx.answerCbQuery();
  const text = `⚔️ *How Raids Work*\n\nEngage with raid links posted in chat to earn points!`;
  return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'onboard_back' }]] } });
});

bot.action('onboard_back', async (ctx) => {
  await ctx.answerCbQuery();
  return sendOnboardingMenu(ctx);
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

    // Show Admin Panel button if user is a legacy admin OR has any RBAC role
    const showAdminPanel = isAdmin(telegramId) || await hasAnyRbacRole(telegramId);
    if (showAdminPanel) {
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

bot.command(['wallet', `wallet@${BOT_USERNAME}`], async (ctx) => {
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
  if (!isAdmin(ctx.from.id) && !(await hasAnyRbacRole(ctx.from.id))) return ctx.reply('⛔ Unauthorized.');
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
  if (!senderId || !(await isSuperAdminOrHigherRBAC(senderId))) return ctx.reply('\u26D4 Unauthorized. Requires Super Admin.');
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

    const webAppUrl = WEBAPP_URL + '&mode=treasury';
    const treasuryKeyboard = [
      [{ text: '🚀 Launch Mini App Dashboard', web_app: { url: webAppUrl } }],
      [
        { text: '📥 Receive', callback_data: 'action_treasury_receive' },
        { text: '💸 Send', callback_data: 'action_treasury_send_guide' }
      ],
      [{ text: '🔄 Swap Tokens', callback_data: 'action_treasury_swap' }],
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
  if (!senderId || !(await isSuperAdminOrHigherRBAC(senderId))) return ctx.reply('\u26D4 Unauthorized. Requires Super Admin.');
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
  if (!senderId || !(await isModOrHigher(senderId))) return ctx.reply('\u26D4 Unauthorized.');
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
  if (!senderId || !(await isModOrHigher(senderId))) return ctx.reply('\u26D4 Unauthorized.');
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
  if (!senderId || !(await isModOrHigher(senderId))) return ctx.reply('\u26D4 Unauthorized.');
  
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
  if (!senderId || !(await isModOrHigher(senderId))) return ctx.reply('\u26D4 Unauthorized.');

  const { data: triggers } = await supabase.from('chat_triggers').select('keyword, response');
  if (!triggers || triggers.length === 0) return ctx.reply('\u2139\uFE0F No custom chat triggers set.');
  let text = '\u{1F4AC} *Active Chat Triggers:*\n\n';
  triggers.forEach((t, i) => { text += `${i + 1}. \`${t.keyword}\` \u2192 _${t.response}_\n`; });
  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '\u2B05\uFE0F Back', callback_data: 'admin_keywords' }]] }
  });
});


// ⚠️ Allowed Telegram user IDs for Dev Options parsed dynamically from environment variable
const DEV_PANEL_ALLOWED_IDS = (process.env.DEV_PANEL_ALLOWED_IDS || '')
  .split(',')
  .map((id) => Number(id.trim()))
  .filter((id) => Number.isFinite(id) && id > 0);

// ─── Reusable Admin Panel Renderer ───────────────────────────────────────────
async function sendAdminPanel(ctx: any) {
  const senderId: number = ctx.from?.id;
  if (!senderId) return ctx.reply('⛔ Unauthorized.');

  // Check legacy admin OR RBAC role
  const authorized = isAdmin(senderId) || await hasAnyRbacRole(senderId);
  if (!authorized) {
    return ctx.reply('⛔ Unauthorized.');
  }

  const adminKeyboard: any[] = [
    [
      { text: '🏦 View Treasury', callback_data: 'admin_treasury' },
      { text: '🪂 Airdrop Token', callback_data: 'admin_airdrop' },
    ],
    [
      { text: '⚙️ Reset Points', callback_data: 'admin_reset' },
      { text: '🔑 Keywords', callback_data: 'admin_keywords' },
    ],
    [
      { text: '💬 Trivia Settings', callback_data: 'admin_trivia' },
      { text: '🔠 Scramble Control', callback_data: 'admin_scramble' },
    ],
    [
      { text: '❓ Help Guide', callback_data: 'admin_help' },
    ],
    [
      { text: '🏛️ Treasury Wallet', callback_data: 'action_treasury_home' },
    ],
    [
      { text: '⬅️ Back to Wallet', callback_data: 'action_wallet_home' },
    ],
  ];

  // Only show the Dev Options button to hardcoded dev IDs
  if (DEV_PANEL_ALLOWED_IDS.includes(senderId)) {
    adminKeyboard.splice(4, 0, [
      { text: '🛠️ Dev Options', callback_data: 'dev_panel' },
    ]);
  }

  const text = '🛡️ *WifhPaws Admin Control Center*\n\nSelect an option below:';

  if (ctx.callbackQuery) {
    try {
      await ctx.answerCbQuery();
      return ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: adminKeyboard },
      });
    } catch {
      // Fallback if message can't be edited
    }
  }
  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: adminKeyboard },
  });
}

bot.action('admin_tools_menu', async (ctx) => sendAdminPanel(ctx));

// Build DevPanel dependency bundle (provider, contract info, dev signer)
const devPanelDeps: DevPanelDeps = {
  provider,
  wifhContractAddress: WIFH_CONTRACT_ADDRESS,
  erc20Abi: ERC20_ABI,
  devSigner,
};

// ==========================================
// ADMIN / DEV PANEL COMMANDS
// ==========================================

// Setup Dev Panel actions — passes deps so the panel can show live Dev Wallet data
setupDevPanelActions(bot, async (id) => (id !== undefined ? DEV_PANEL_ALLOWED_IDS.includes(id) : false), devPanelDeps);

bot.command(['admin', `admin@${BOT_USERNAME}`], async (ctx) => {
  if (!ctx.from) return ctx.reply('⛔ Unauthorized.');
  const isAuthorized = isAdmin(ctx.from.id) || await hasAnyRbacRole(ctx.from.id);
  if (!isAuthorized) return ctx.reply('⛔ Unauthorized.');
  return sendAdminPanel(ctx);
});

bot.action('action_open_admin', async (ctx) => {
  return sendAdminPanel(ctx);
});

bot.command(['devpanel', `devpanel@${BOT_USERNAME}`], async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') {
      const botUsername = ctx.botInfo?.username || 'WifhPawsBot';
      return ctx.reply('🔒 Dev panel is only available in private messages.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛠️ Open Dev Panel', url: `https://t.me/${botUsername}?start=devpanel` }]
          ]
        }
      });
    }
    if (!ctx.from || !DEV_PANEL_ALLOWED_IDS.includes(ctx.from.id)) {
      return ctx.reply('⛔ Unauthorized. This command is restricted to hardcoded developers.');
    }
    return await sendDevPanelMenu(ctx, devPanelDeps);
  } catch (err: any) {
    console.error('[/devpanel] Unhandled error:', err?.message || err);
    return ctx.reply('❌ Failed to open the Dev Panel. Please try again.');
  }
});

function renderTriviaControlMenu() {
  const activeCategory = getActiveTriviaCategory();
  const isLore = activeCategory === 'crypto_wifh';
  const isGk = activeCategory === 'general_knowledge';

  const text =
    `🧠 *Trivia Control Panel*\n\n` +
    `Select the active category for live trivia games:\n\n` +
    `• 🐕 *Crypto & $WIFH Lore* — Deep ecosystem lore, tokenomics & history\n` +
    `• 🌍 *General Knowledge* — Broad general trivia questions\n\n` +
    `🎯 *Current Category:* ${isLore ? '🐕 *Crypto & $WIFH Lore*' : '🌍 *General Knowledge*'}\n\n` +
    `💡 *Note:* Trivia games are played in community group chats. To start a game, run \`/start_trivia\` in your group chat.`;

  const keyboard = [
    [
      {
        text: `${isLore ? '✅ ' : ''}🐕 Crypto & $WIFH Lore`,
        callback_data: 'admin_trivia_set_crypto_wifh',
      },
    ],
    [
      {
        text: `${isGk ? '✅ ' : ''}🌍 General Knowledge`,
        callback_data: 'admin_trivia_set_general_knowledge',
      },
    ],
    [
      {
        text: '⬅️ Back to Trivia Settings',
        callback_data: 'admin_trivia',
      },
    ],
  ];

  return { text, keyboard };
}

bot.action('admin_trivia_control', async (ctx) => {
  if (!ctx.from || !(await isModOrHigher(ctx.from.id))) return ctx.answerCbQuery('⛔ Unauthorized');
  await ctx.answerCbQuery();
  try {
    const menu = renderTriviaControlMenu();
    await ctx.editMessageText(menu.text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (err: any) {
    console.error('[admin_trivia_control] error:', err?.message || err);
    try {
      const menu = renderTriviaControlMenu();
      await ctx.editMessageText(menu.text.replace(/[*_`]/g, ''), {
        reply_markup: { inline_keyboard: menu.keyboard },
      });
    } catch {}
  }
});

bot.action(/admin_trivia_set_(crypto_wifh|general_knowledge)/, async (ctx) => {
  if (!ctx.from || !(await isModOrHigher(ctx.from.id))) return ctx.answerCbQuery('⛔ Unauthorized');
  const targetCategory = ctx.match[1] as TriviaCategory;
  const current = getActiveTriviaCategory();

  if (current === targetCategory) {
    return ctx.answerCbQuery('✅ This category is already active!');
  }

  setActiveTriviaCategory(targetCategory);
  const label = targetCategory === 'crypto_wifh' ? 'Crypto & $WIFH Lore' : 'General Knowledge';
  await ctx.answerCbQuery(`✅ Category set to: ${label}`);

  try {
    const menu = renderTriviaControlMenu();
    await ctx.editMessageText(menu.text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (err: any) {
    console.error('[admin_trivia_set] error:', err?.message || err);
    try {
      const menu = renderTriviaControlMenu();
      await ctx.editMessageText(menu.text.replace(/[*_`]/g, ''), {
        reply_markup: { inline_keyboard: menu.keyboard },
      });
    } catch {}
  }
});

bot.action('admin_trivia', async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isModOrHigher(ctx.from!.id))) return ctx.reply('⛔ Unauthorized.');

  try {
    const config = await getPayoutConfig();
    const questionCount = await getQuestionCount();
    const activeCategory = getActiveTriviaCategory();
    const categoryLabel = activeCategory === 'crypto_wifh' ? '🐕 Crypto & $WIFH Lore' : '🌍 General Knowledge';

    const text = `🧠 *Trivia Settings & Help*\n\n` +
      `🏆 *Current Rewards (per game):*\n` +
      `🥇 1st Place: *${config.first} WIFH*\n` +
      `🥈 2nd Place: *${config.second} WIFH*\n` +
      `🥉 3rd Place: *${config.third} WIFH*\n\n` +
      `📋 *Questions per Game:* \`${questionCount}\`\n` +
      `📂 *Active Category:* *${categoryLabel}*\n\n` +
      `🛠️ *Trivia Commands (Admins Only):*\n` +
      `• \`/start_trivia\` — Start a ${questionCount}-question trivia game in any group chat.\n` +
      `• \`/stop_trivia\` — Stop an active trivia game early.\n` +
      `• \`/setpayout <1st> <2nd> <3rd>\` — Update the payout rewards.\n` +
      `• \`/setquestions <number>\` — Change the number of questions per game.\n` +
      `• \`/payout\` — View current reward config & pending winners.\n` +
      `• \`/payout_trivia [amounts]\` — Distribute pending rewards.\n` +
      `• \`/skip_payout\` — Dismiss pending rewards without paying.\n\n` +
      `_Example:_ \`/setpayout 100 50 25\`  |  \`/setquestions 15\``;

    const keyboard = [
      [{ text: "🧠 Open Trivia Control", callback_data: "admin_trivia_control" }],
      [{ text: "⬅️ Back", callback_data: "admin_tools_menu" }]
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err: any) {
    console.error('[Admin Trivia] Error:', err.message);
    await ctx.reply('❌ Failed to load trivia settings.');
  }
});

bot.action('admin_scramble', async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isModOrHigher(ctx.from!.id))) return ctx.reply('⛔ Unauthorized.');

  try {
    const config = await getScramblePayoutConfig();
    const text = `🔠 *Word Scramble Settings & Control*\n\n` +
      `🏆 *Current Rewards (per game):*\n` +
      `🥇 1st Place: *${config.first} WIFH*\n` +
      `🥈 2nd Place: *${config.second} WIFH*\n` +
      `🥉 3rd Place: *${config.third} WIFH*\n\n` +
      `🛠️ *Scramble Commands (Admins Only):*\n` +
      `• \`/start_scramble\` — Start a 5-round scramble game in a group.\n` +
      `• \`/stop_scramble\` — Stop an active scramble game.\n` +
      `• \`/setpayout_scramble <1st> <2nd> <3rd>\` — Update default payout rewards.\n` +
      `• \`/payout_scramble [amounts]\` — Distribute pending rewards to winners.\n` +
      `  (To set specific amounts manually: \`/payout_scramble <1st> [2nd] [3rd]\`)\n\n` +
      `*Example:* \`/setpayout_scramble 100 50 25\`  |  \`/payout_scramble\``;

    const keyboard = [
      [{ text: "⬅️ Back", callback_data: "admin_tools_menu" }]
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err: any) {
    console.error('[Admin Scramble] Error:', err.message);
    await ctx.reply('❌ Failed to load scramble settings.');
  }
});

bot.command(['setpayout_scramble', `setpayout_scramble@${BOT_USERNAME}`], async (ctx) => {
  if (!ctx.from || !(await isModOrHigher(ctx.from.id))) {
    return ctx.reply('⛔ Unauthorized. Only Mods or higher can configure scramble payouts.');
  }

  const message = ctx.message as any;
  const text = message?.text || '';
  const args = text.trim().split(/\s+/).slice(1);

  if (args.length !== 3) {
    return ctx.reply(
      '⚠️ *Usage:*\n`/setpayout_scramble <1st_place_amount> <2nd_place_amount> <3rd_place_amount>`\n\n' +
      '_Example: `/setpayout_scramble 100 50 25`_',
      { parse_mode: 'Markdown' }
    );
  }

  const [first, second, third] = args.map(Number);

  if (!Number.isFinite(first) || !Number.isFinite(second) || !Number.isFinite(third)) {
    return ctx.reply('❌ Invalid amounts. Please provide valid numerical values.');
  }

  try {
    await setScramblePayoutConfig(first, second, third);
    return ctx.reply(
      `✅ *Scramble Payouts Updated!*\n\n` +
      `🥇 1st Place: *${first} WIFH*\n` +
      `🥈 2nd Place: *${second} WIFH*\n` +
      `🥉 3rd Place: *${third} WIFH*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[setpayout_scramble error]', err);
    return ctx.reply('❌ Failed to update scramble payouts in the database.');
  }
});

bot.command(['setpayout', `setpayout@${BOT_USERNAME}`], async (ctx) => {
  if (!ctx.from || !(await isModOrHigher(ctx.from.id))) {
    return ctx.reply('⛔ Unauthorized. Only Mods or higher can configure trivia payouts.');
  }

  const message = ctx.message as any;
  const text = message?.text || '';
  const args = text.trim().split(/\s+/).slice(1);

  if (args.length !== 3) {
    return ctx.reply(
      'ℹ️ *Usage:* `/setpayout <1st> <2nd> <3rd>`\n\n' +
      '• `<1st>`: Reward for 1st place (in WIFH)\n' +
      '• `<2nd>`: Reward for 2nd place (in WIFH)\n' +
      '• `<3rd>`: Reward for 3rd place (in WIFH)\n\n' +
      '*Example:* `/setpayout 100 50 25`',
      { parse_mode: 'Markdown' }
    );
  }

  const [raw1, raw2, raw3] = args;
  const first = Number(raw1);
  const second = Number(raw2);
  const third = Number(raw3);

  if (
    isNaN(first) || isNaN(second) || isNaN(third) ||
    !isFinite(first) || !isFinite(second) || !isFinite(third)
  ) {
    return ctx.reply(
      '❌ *Invalid amounts:* Payout rewards must be valid numbers.\n\n' +
      '*Usage:* `/setpayout <1st> <2nd> <3rd>`\n' +
      '_Example:_ `/setpayout 100 50 25`',
      { parse_mode: 'Markdown' }
    );
  }

  if (first < 0 || second < 0 || third < 0) {
    return ctx.reply('❌ *Invalid amounts:* Payout amounts cannot be negative.', { parse_mode: 'Markdown' });
  }

  try {
    await setPayoutConfig(first, second, third);
    const confirmation =
      `✅ *Trivia Payout Rewards Updated!*\n\n` +
      `🏆 *New Reward Structure (per game):*\n` +
      `🥇 *1st Place:* \`${first} WIFH\`\n` +
      `🥈 *2nd Place:* \`${second} WIFH\`\n` +
      `🥉 *3rd Place:* \`${third} WIFH\`\n\n` +
      `💡 _These rewards will automatically apply to upcoming trivia games._`;
    await ctx.reply(confirmation, { parse_mode: 'Markdown' });
  } catch (err: any) {
    console.error('Error setting payouts:', err.message || err);
    await ctx.reply(`❌ *Failed to save payout config:* ${err.message || 'Unknown error'}`);
  }
});

bot.command(['setquestions', `setquestions@${BOT_USERNAME}`], async (ctx) => {
  if (!ctx.from || !(await isModOrHigher(ctx.from.id))) {
    return ctx.reply('⛔ Unauthorized. Only Mods or higher can change the trivia question count.');
  }

  const message = ctx.message as any;
  const text = message?.text || '';
  const args = text.trim().split(/\s+/).slice(1);

  if (args.length === 0) {
    try {
      const current = await getQuestionCount();
      return ctx.reply(
        `ℹ️ *Current trivia question count:* \`${current}\`\n\n` +
        `*Usage:* \`/setquestions <number>\`\n` +
        `_Example:_ \`/setquestions 15\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      return ctx.reply(`❌ Failed to read current question count: ${err.message}`);
    }
  }

  const count = Number(args[0]);

  if (!Number.isInteger(count) || count < 1 || count > 50) {
    return ctx.reply(
      '❌ *Invalid number.* Question count must be a whole number between 1 and 50.\n\n' +
      '*Usage:* \`/setquestions <number>\`\n' +
      '_Example:_ \`/setquestions 15\`',
      { parse_mode: 'Markdown' }
    );
  }

  try {
    await setQuestionCount(count);
    await ctx.reply(
      `✅ *Trivia question count updated to:* \`${count}\`\n\n` +
      `Questions will be spread evenly across all 5 categories (Animals, Vehicles, Film, Music, Television) and shuffled into a random mix.\n\n` +
      `💡 _This takes effect on the next_ \`/start_trivia\` _game._`,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    console.error('[setquestions] Error:', err.message || err);
    await ctx.reply(`❌ Failed to update question count: ${err.message || 'Unknown error'}`);
  }
});

bot.action('admin_help', async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isModOrHigher(ctx.from!.id))) return ctx.reply('\u26D4 Unauthorized.');

  const helpText = `🛡️ *Admin Commands Cheat Sheet*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 *Tier 0 — Global Masters:*\n` +
    `• \`/initproject @owner [name]\` — Bootstrap a project instance\n\n` +
    `🏛️ *Tier 1 — Project Owner:*\n` +
    `• \`/addadmin @user\` — Add a moderator\n` +
    `• \`/promotesuper @user\` — Promote mod → Super Admin\n` +
    `• \`/demote @user\` — Demote Super Admin → Mod\n` +
    `• \`/removeadmin @user\` — Remove all privileges\n\n` +
    `⭐ *Tier 2a — Super Admin (Financial):*\n` +
    `• \`/addadmin @user\` — Add a moderator\n` +
    `• \`/treasury\` — View live project treasury\n` +
    `• \`/airdrop @username 50\` — Send 50 WIFH\n` +
    `• \`/airdrop @username $10\` — Send $10 of WIFH\n` +
    `• \`/tsend 10 wifh @user\` — Send from treasury\n` +
    `• \`/tswap 10 eth wifh\` — Swap treasury funds\n` +
    `• \`/tbuy 0.1\` — Buy WIFH from treasury\n` +
    `• \`/tsell 100\` — Sell WIFH from treasury\n` +
    `• \`/payout_trivia\` — Distribute trivia rewards\n` +
    `• \`/setpayout\` — Configure trivia payouts\n\n` +
    `🛡️ *Tier 2b — Moderators:*\n` +
    `• \`/start_trivia\` — Start trivia game\n` +
    `• \`/stop_trivia\` — Stop trivia game\n` +
    `• \`/addkeyword hello 10\` — Add rewarded keyword\n` +
    `• \`/removekeyword hello\` — Remove keyword\n` +
    `• \`/clearallkeywords\` — Clear all keywords\n` +
    `• \`/addpoints @user 100\` — Give points\n` +
    `• \`/resetpoints @user\` — Reset user points\n` +
    `• \`/resetallpoints\` — Reset all points\n` +
    `• 🚫 No treasury/financial access\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 *General:*\n` +
    `• \`/myrole\` — Check your role\n` +
    `• \`/roles\` — List project staff\n` +
    `• \`/rbachelp\` — Full RBAC reference\n` +
    `• \`/admin\` — Open Admin Control Center`;

  return ctx.reply(helpText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: BACK_TO_ADMIN } });
});

// Transfer Command (/send)
bot.command(['send', `send@${BOT_USERNAME}`], async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('\u{1F512} Transfers can only be initiated in private messages for security.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply('\u26A0\uFE0F *Usage:* `/send [amount] [eth/wifh] [0xAddress or @username]`\n\n*Examples:*\n\u2022 `/send 10 wifh @username`\n\u2022 `/send 0.001 eth 0x123...`', { parse_mode: 'Markdown' });
  }

  const amountStr = args[1];
  const tokenType = args[2].toLowerCase();
  const recipientInput: string = String(args[3] || '');
  const amountVal = Number(amountStr);
  if (!Number.isFinite(amountVal) || amountVal <= 0) return ctx.reply('\u274C Please enter a valid positive numerical amount.');

  try {
    const senderData = await getOrCreateWallet(ctx.from.id);
    const privateKey = decryptPrivateKey(senderData);
    const signer = new ethers.Wallet(privateKey, provider);

    let destinationAddress = '';
    if ((ethers.isAddress as any)(recipientInput)) {
      destinationAddress = recipientInput;
    } else {
      const recipientUser = await resolveRecipientUser(recipientInput, ctx);
      if (!recipientUser) return ctx.reply(`\u274C Could not find a registered user named ${recipientInput.startsWith('@') ? recipientInput : '@' + recipientInput}.`);
      const recipientWallet = await getOrCreateWallet(recipientUser.telegram_id);
      destinationAddress = recipientWallet.public_address;
    }

    const ethBalance = await provider.getBalance(signer.address);
    if (ethBalance === 0n) return ctx.reply('\u26A0\uFE0F You do not have enough native ETH on Robinhood Chain to pay for gas fees.');

    const statusMsg = await ctx.reply('\u23F3 Processing transaction on Robinhood Chain...');
    let txHash = '';
    let successDetails = '';

    if (tokenType === 'eth') {
      const tx = await signer.sendTransaction({ to: destinationAddress, value: ethers.parseEther(amountStr), gasLimit: 100000n });
      txHash = tx.hash;
      await tx.wait();
      successDetails =
        `\u{1F4B8} *Amount:* \`${amountStr} ETH\`\n` +
        `\u{1F4CD} *To:* \`${destinationAddress}\`\n` +
        `\u{1F517} *Tx Hash:* \`${txHash}\``;
    } else if (tokenType === 'wifh') {
      if (!WIFH_CONTRACT_ADDRESS) return ctx.reply('\u274C WIFH contract address is not configured.');
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, signer);
      const decimals = await contract.decimals();
      const totalAmount = ethers.parseUnits(amountStr, decimals);
      const { userAmount, feeAmount } = calculateAndRouteFee(totalAmount);

      const tx = await contract.transfer(destinationAddress, userAmount, { gasLimit: 150000n });
      txHash = tx.hash;
      await tx.wait();

      if (feeAmount > 0n) {
        const devFeeAddress = devSigner?.address || getDevWalletAddress();
        await dispatchFeesToDevWallet(feeAmount, contract, signer, devFeeAddress || undefined);
      }

      const receivedFormatted = ethers.formatUnits(userAmount, decimals);
      const feeFormatted = ethers.formatUnits(feeAmount, decimals);

      successDetails =
        `\u{1F4B8} *Total Sent:* \`${amountStr} WIFH\`\n` +
        `\u{1F4E5} *Recipient Received (99%):* \`${receivedFormatted} WIFH\`\n` +
        `\u{1F6E0}\uFE0F *Dev Fee (1%):* \`${feeFormatted} WIFH\`\n` +
        `\u{1F4CD} *To:* \`${destinationAddress}\`\n` +
        `\u{1F517} *Tx Hash:* \`${txHash}\``;
    } else {
      return ctx.reply('\u274C Unsupported token. Use `eth` or `wifh`.');
    }

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `\u2705 *Transaction Successful!*\n\n${successDetails}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`\u274C Transaction failed: ${err.message}`);
  }
});

// Treasury Transfer Command (/tsend)
bot.command('tsend', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Transfers can only be initiated in private messages for security.');
  if (!(await isSuperAdminOrHigherRBAC(ctx.from.id))) return ctx.reply('⛔ Unauthorized.');
  if (!treasurySigner) return ctx.reply('❌ Treasury wallet is not configured in .env.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply('⚠️ *Usage:* `/tsend [amount] [eth/wifh] [0xAddress or @username]`\n\n*Examples:*\n• `/tsend 10 wifh @username`\n• `/tsend 0.001 eth 0x123...`', { parse_mode: 'Markdown' });
  }

  const amountStr = args[1];
  const tokenType = args[2].toLowerCase();
  const recipientInput: string = String(args[3] || '');
  const amountVal = Number(amountStr);
  if (!Number.isFinite(amountVal) || amountVal <= 0) return ctx.reply('❌ Please enter a valid positive numerical amount.');

  try {
    let destinationAddress = '';
    if ((ethers.isAddress as any)(recipientInput)) {
      destinationAddress = recipientInput;
    } else {
      const recipientUser = await resolveRecipientUser(recipientInput, ctx);
      if (!recipientUser) return ctx.reply(`❌ Could not find a registered user named ${recipientInput.startsWith('@') ? recipientInput : '@' + recipientInput}.`);
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
  const amount = Number(amountStr);

  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('\u274C Please enter a valid positive numerical swap amount.');

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
  if (!(await isSuperAdminOrHigherRBAC(ctx.from.id))) return ctx.reply('⛔ Unauthorized. Only admins can swap treasury funds.');
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
  const amount = Number(amountStr);

  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('❌ Please enter a valid positive numerical swap amount.');

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
// DEV WALLET COMMANDS (/dsend, /dswap, /dbuy, /dsell)
// ==========================================

// Dev Wallet Transfer Command (/dsend)
bot.command('dsend', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Dev Wallet transfers can only be initiated in private messages.');
  if (!ctx.from || !DEV_PANEL_ALLOWED_IDS.includes(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  if (!devSigner) return ctx.reply('❌ Dev Wallet private key is not configured. Set `DEV_WALLET_PRIVATE_KEY` in your environment variables.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply(
      '⚠️ *Usage:* `/dsend [amount] [eth/wifh] [0xAddress or @username]`\n\n*Examples:*\n• `/dsend 10 wifh @username`\n• `/dsend 0.001 eth 0x123...`',
      { parse_mode: 'Markdown' }
    );
  }

  const amountStr = args[1];
  const tokenType = args[2].toLowerCase();
  const recipientInput: string = String(args[3] || '');
  const amountVal = Number(amountStr);
  if (!Number.isFinite(amountVal) || amountVal <= 0) return ctx.reply('❌ Please enter a valid positive numerical amount.');

  try {
    let destinationAddress = '';
    if ((ethers.isAddress as any)(recipientInput)) {
      destinationAddress = recipientInput;
    } else {
      const recipientUser = await resolveRecipientUser(recipientInput, ctx);
      if (!recipientUser) return ctx.reply(`❌ Could not find a registered user named ${recipientInput.startsWith('@') ? recipientInput : '@' + recipientInput}.`);
      const recipientWallet = await getOrCreateWallet(recipientUser.telegram_id);
      destinationAddress = recipientWallet.public_address;
    }

    const ethBalance = await provider.getBalance(devSigner.address);
    if (ethBalance === 0n) return ctx.reply('⚠️ Dev Wallet does not have enough native ETH to pay for gas fees.');

    const statusMsg = await ctx.reply('⏳ Processing Dev Wallet transaction on Robinhood Chain...');
    let txHash = '';
    if (tokenType === 'eth') {
      const tx = await devSigner.sendTransaction({ to: destinationAddress, value: ethers.parseEther(amountStr), gasLimit: 100000n });
      txHash = tx.hash;
      await tx.wait();
    } else if (tokenType === 'wifh') {
      if (!WIFH_CONTRACT_ADDRESS) return ctx.reply('❌ WIFH contract address is not configured.');
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, devSigner);
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
      `✅ *Dev Wallet Transfer Successful!*\n\n🛠️ *From:* Dev Wallet\n💸 *Amount:* \`${amountStr} ${tokenType.toUpperCase()}\`\n📍 *To:* \`${destinationAddress}\`\n🔗 *Tx Hash:* \`${txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Dev Wallet transaction failed: ${err.message}`);
  }
});

// Dev Wallet Burn Command (/dburn)
bot.command('dburn', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Dev Wallet burns can only be initiated in private messages.');
  if (!ctx.from || !DEV_PANEL_ALLOWED_IDS.includes(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  if (!devSigner) return ctx.reply('❌ Dev Wallet private key is not configured.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) {
    return ctx.reply(
      '⚠️ *Usage:* `/dburn [amount]`\n\n*Example:*\n• `/dburn 1000`',
      { parse_mode: 'Markdown' }
    );
  }

  const amountStr = args[1];
  const amountVal = Number(amountStr);
  if (!Number.isFinite(amountVal) || amountVal <= 0) return ctx.reply('❌ Please enter a valid positive numerical amount.');

  try {
    const ethBalanceWei = await provider.getBalance(devSigner.address);
    if (ethBalanceWei === 0n) return ctx.reply('❌ Insufficient native ETH gas in Dev Wallet to process transaction. Please top up gas before burning tokens.');

    if (!WIFH_CONTRACT_ADDRESS) return ctx.reply('❌ WIFH contract address is not configured.');
    const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, devSigner);

    const decimals = await contract.decimals();
    const amountWei = ethers.parseUnits(amountStr, decimals);
    
    const balanceWei = await contract.balanceOf(devSigner.address);
    if (balanceWei < amountWei) return ctx.reply('❌ Insufficient WIFH tokens in Dev Wallet to burn this amount.');

    const statusMsg = await ctx.reply(`⏳ Processing Dev Wallet burn of ${amountStr} WIFH on Robinhood Chain...`);
    const deadAddress = '0x000000000000000000000000000000000000dead';
    
    const tx = await contract.transfer(deadAddress, amountWei, { gasLimit: 150000n });
    await tx.wait();

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ *Burn Successful!*\n\n🔥 Permanently removed \`${amountStr} WIFH\` from circulation.\n\n🔗 *Tx Hash:*\n\`${tx.hash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    if (err.message?.includes('insufficient funds for intrinsic transaction cost')) {
      return ctx.reply('❌ Insufficient native ETH gas in Dev Wallet to process transaction. Please top up gas before burning tokens.');
    }
    return ctx.reply(`❌ Burn transaction failed: ${err.message}`);
  }
});

// Dev Wallet Swap Command (/dswap)
bot.command('dswap', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Dev Wallet swaps can only be executed in private messages.');
  if (!ctx.from || !DEV_PANEL_ALLOWED_IDS.includes(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  if (!devSigner) return ctx.reply('❌ Dev Wallet private key is not configured. Set `DEV_WALLET_PRIVATE_KEY` in your environment variables.');

  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 4) {
    return ctx.reply(
      '⚠️ *Dev Wallet Swap Syntax:* `/dswap [amount] [fromToken] [toToken]`\n\n*Examples:*\n• `/dswap 100 wifh eth`\n• `/dswap 0.01 eth wifh`',
      { parse_mode: 'Markdown' }
    );
  }

  const amountStr = args[1];
  const fromToken = args[2].toLowerCase();
  const toToken = args[3].toLowerCase();
  const amount = Number(amountStr);

  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('❌ Please enter a valid positive numerical swap amount.');
  if (!['wifh', 'eth'].includes(fromToken) || !['wifh', 'eth'].includes(toToken) || fromToken === toToken) {
    return ctx.reply('❌ Invalid swap pair. Supported pairs are `wifh` ↔ `eth`.');
  }

  try {
    const statusMsg = await ctx.reply('⏳ Calculating rate & executing Dev Wallet on-chain swap via DEX...');

    const result = await executeOnChainSwap(null, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount, devSigner);

    const poolRate = await getPoolRate();
    const rateDisplay = fromToken === 'eth'
      ? `1 ETH = ${Math.round(poolRate).toLocaleString()} WIFH`
      : `1 WIFH = ${(1 / poolRate).toFixed(8)} ETH`;

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ *DEV WALLET SWAP SUCCESSFUL!*\n\n🛠️ *Wallet:* Dev Wallet\n🔄 *Paid:* \`${amountStr} ${fromToken.toUpperCase()}\`\n🎉 *Received:* \`${result.received} ${toToken.toUpperCase()}\` (~$${result.receivedUsd} USD)\n📈 *Rate:* ${rateDisplay}\n🔗 *Tx:* \`${result.txHash}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    return ctx.reply(`❌ Dev Wallet swap failed: ${err.message}`);
  }
});

bot.command('dbuy', async (ctx) => {
  if (!ctx.from || !DEV_PANEL_ALLOWED_IDS.includes(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) return ctx.reply('⚠️ *Usage:* `/dbuy [amount_in_eth]`\n_Buys WIFH using Dev Wallet ETH_', { parse_mode: 'Markdown' });
  ctx.message.text = `/dswap ${args[1]} eth wifh`;
  return bot.handleUpdate(ctx.update);
});

bot.command('dsell', async (ctx) => {
  if (!ctx.from || !DEV_PANEL_ALLOWED_IDS.includes(ctx.from.id)) return ctx.reply('⛔ Unauthorized.');
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 2) return ctx.reply('⚠️ *Usage:* `/dsell [amount_in_wifh]`\n_Sells Dev Wallet WIFH for ETH_', { parse_mode: 'Markdown' });
  ctx.message.text = `/dswap ${args[1]} wifh eth`;
  return bot.handleUpdate(ctx.update);
});

// ==========================================
// ADMIN HELP & TREASURY COMMANDS
// ==========================================


bot.command('adminhelp', async (ctx) => {
    if (!(await isModOrHigher(ctx.from.id))) return ctx.reply("\u26D4 Unauthorized.");

  const helpText = `🛡️ *Admin Commands Cheat Sheet*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 *Tier 0 — Global Masters:*\n` +
    `• \`/initproject @owner [name]\` — Bootstrap a project instance\n\n` +
    `🏛️ *Tier 1 — Project Owner:*\n` +
    `• \`/addadmin @user\` — Add a moderator\n` +
    `• \`/promotesuper @user\` — Promote mod → Super Admin\n` +
    `• \`/demote @user\` — Demote Super Admin → Mod\n` +
    `• \`/removeadmin @user\` — Remove all privileges\n\n` +
    `⭐ *Tier 2a — Super Admin (Financial):*\n` +
    `• \`/addadmin @user\` — Add a moderator\n` +
    `• \`/treasury\` — View live project treasury\n` +
    `• \`/airdrop @username 50\` — Send 50 WIFH\n` +
    `• \`/airdrop @username $10\` — Send $10 of WIFH\n` +
    `• \`/tsend 10 wifh @user\` — Send from treasury\n` +
    `• \`/tswap 10 eth wifh\` — Swap treasury funds\n` +
    `• \`/tbuy 0.1\` — Buy WIFH from treasury\n` +
    `• \`/tsell 100\` — Sell WIFH from treasury\n` +
    `• \`/payout_trivia\` — Distribute trivia rewards\n` +
    `• \`/setpayout\` — Configure trivia payouts\n\n` +
    `🛡️ *Tier 2b — Moderators:*\n` +
    `• \`/start_trivia\` — Start trivia game\n` +
    `• \`/stop_trivia\` — Stop trivia game\n` +
    `• \`/addkeyword hello 10\` — Add rewarded keyword\n` +
    `• \`/removekeyword hello\` — Remove keyword\n` +
    `• \`/clearallkeywords\` — Clear all keywords\n` +
    `• \`/addpoints @user 100\` — Give points\n` +
    `• \`/resetpoints @user\` — Reset user points\n` +
    `• \`/resetallpoints\` — Reset all points\n` +
    `• 🚫 No treasury/financial access\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 *General:*\n` +
    `• \`/myrole\` — Check your role\n` +
    `• \`/roles\` — List project staff\n` +
    `• \`/rbachelp\` — Full RBAC reference\n` +
    `• \`/admin\` — Open Admin Control Center`;

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

    const userData = await resolveRecipientUser(targetUsername, ctx);

    if (!userData) {
        return ctx.reply(`\u274C Could not find a user with the handle @${targetUsername}. Make sure they have interacted with the bot or group!`);
    }

    const { error: adminError } = await supabase
        .from('admins')
        .upsert({ telegram_id: userData.telegram_id, username: userData.username || targetUsername });

    if (adminError) {
        return ctx.reply(`\u274C Failed to grant admin privileges in the database. (Make sure the 'admins' table exists). Details: ${adminError.message}`);
    }
    
    // Add to memory immediately so it works without restarting
    dynamicAdmins.add(userData.telegram_id.toString());

    await ctx.reply(`\u2705 Success! @${targetUsername} has been granted admin privileges.`);
});




bot.command('treasury', async (ctx) => {
  const senderId = ctx.from.id;
  if (!(await isSuperAdminOrHigherRBAC(senderId))) return ctx.reply('\u26D4 Unauthorized. Project treasury details are restricted to admins.');
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
  if (!(await isSuperAdminOrHigherRBAC(senderId))) return ctx.reply('\u26D4 Unauthorized. Only project admins can trigger token airdrops.');
  if (!treasurySigner) return ctx.reply('\u274C Project Treasury wallet is not configured. Add `TREASURY_PRIVATE_KEY` to Render environment variables.');
  const args = ctx.message.text.split(' ').filter(Boolean);
  if (args.length < 3) {
    return ctx.reply('\u26A0\uFE0F *Admin Airdrop Usage:* `/airdrop [@username or 0xAddress] [amount or $dollarAmount]`\n\n*Examples:*\n\u2022 `/airdrop @username $10` (Airdrop $10 worth of WIFH)\n\u2022 `/airdrop @username 500` (Airdrop 500 WIFH tokens)', { parse_mode: 'Markdown' });
  }
  const targetInput: string = String(args[1] || '');
  let rawAmountStr = args[2].trim();
  let isDollar = rawAmountStr.includes('$');
  let rawValue = Number(rawAmountStr.replace('$', ''));

  if (!Number.isFinite(rawValue) || rawValue <= 0) return ctx.reply('\u274C Invalid airdrop amount.');

  try {
    let tokenAmount = rawValue;
    if (isDollar) {
      tokenAmount = Math.round(rawValue * 8000);
    }

    let destinationAddress = '';
    let displayRecipient = targetInput;
    if ((ethers.isAddress as any)(targetInput)) {
      destinationAddress = targetInput;
      displayRecipient = 'External Wallet';
    } else {
      const targetUser = await getTargetUser(ctx, targetInput);
      if (!targetUser) return ctx.reply('\u274C Target user not found.');
      const wallet = await getOrCreateWallet(targetUser.id);
      destinationAddress = wallet.public_address;
      displayRecipient = targetUser.username ? `@${targetUser.username}` : `User ${targetUser.id}`;
    }
    const statusMsg = await ctx.reply('\u23F3 Executing Treasury Airdrop on Robinhood Chain...');
    const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
    const decimals = await contract.decimals();

    // Calculate exact recipient amount and the additional 1% fee
    const userAmount = ethers.parseUnits(tokenAmount.toString(), decimals);
    const feeAmount = userAmount / BigInt(100); // 1%
    const totalRequired = userAmount + feeAmount;

    // Safety check: ensure treasury has enough to cover amount + fee
    const treasuryBalance = await contract.balanceOf(treasurySigner.address);
    if (treasuryBalance < totalRequired) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `\u274C Airdrop failed: Insufficient Treasury balance. Required: ${ethers.formatUnits(totalRequired, decimals)} WIFH.`
      );
    }

    // Transfer exact amount to user
    const txUser = await contract.transfer(destinationAddress, userAmount);
    await txUser.wait();

    // Route fee to Dev Wallet (if any)
    if (feeAmount > 0n) {
      await dispatchFeesToDevWallet(feeAmount, contract, treasurySigner);
    }

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `🎉 AIRDROP SUCCESSFUL!\n\n👤 Recipient: ${displayRecipient}\n🎁 Sent Amount: ${tokenAmount} WIFH\n🐾 The Hood has delivered!\n🔗 Tx Hash: \`${txUser.hash}\``,
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
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
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
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('\u26A0\uFE0F Usage: `/resetpoints @username`');
  await supabase.from('users').upsert({ telegram_id: targetUser.id, points: 0 }, { onConflict: 'telegram_id' });
  return ctx.reply(`\u{1F504} Reset Paw Points to 0 for${targetUser.username ? ' @' + targetUser.username : ' ' + targetUser.id}.`);
});

bot.command('resetallpoints', async (ctx) => {
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
  const { error } = await supabase.from('users').update({ points: 0 }).neq('telegram_id', 0);
  if (error) return ctx.reply(`\u274C Failed to reset points: ${error.message}`);
  return ctx.reply('\u{1F504} Success! All user point balances have been reset to 0.');
});

bot.command('addkeyword', async (ctx) => {
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
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
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('\u26A0\uFE0F Usage: `/removekeyword [word]`');
  const keyword = args[0].toLowerCase().trim();
  const { error } = await supabase.from('dynamic_keywords').delete().eq('keyword', keyword);
  if (error) return ctx.reply(`\u274C Failed to delete keyword: ${error.message}`);
  return ctx.reply(`\u{1F5D1}\uFE0F Keyword "${keyword}" removed.`);
});

bot.command('clearallkeywords', async (ctx) => {
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
  const { error } = await supabase.from('dynamic_keywords').delete().neq('keyword', '');
  if (error) return ctx.reply(`\u274C Failed to clear keywords: ${error.message}`);
  return ctx.reply('\u{1F5D1}\uFE0F All secret keywords have been removed.');
});

bot.command('keywords', async (ctx) => {
  if (!(await isModOrHigher(ctx.from.id))) {
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
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
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
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
  const keyword = ctx.message.text.replace('/removetrigger', '').trim().toLowerCase();
  if (!keyword) return ctx.reply('\u26A0\uFE0F Usage: `/removetrigger keyword`', { parse_mode: 'Markdown' });
  const { error } = await supabase.from('chat_triggers').delete().eq('keyword', keyword);
  if (error) return ctx.reply(`\u274C Failed: ${error.message}`);
  refreshTriggerCache(); // immediate cache update
  return ctx.reply(`\u{1F5D1}\uFE0F Trigger for \`${keyword}\` removed.`, { parse_mode: 'Markdown' });
});

bot.command('listtriggers', async (ctx) => {
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
  const { data: triggers } = await supabase.from('chat_triggers').select('keyword, response');
  if (!triggers || triggers.length === 0) return ctx.reply('\u2139\uFE0F No custom chat triggers set.');
  let text = '\u{1F4AC} *Active Chat Triggers:*\n\n';
  triggers.forEach((t, i) => { text += `${i + 1}. \`${t.keyword}\` \u2192 _${t.response}_\n`; });
  return ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('cleartriggers', async (ctx) => {
  if (!(await isModOrHigher(ctx.from.id))) return ctx.reply('\u26D4 Unauthorized.');
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
  if (!message || !message.text || ctx.from?.is_bot) return next();

  if (ctx.chat.type === 'private' && onboardingStates.get(ctx.from.id) === 'AWAITING_WALLET_INPUT') {
    const input = message.text.trim();
    if (/^0x[a-fA-F0-9]{40}$/i.test(input)) {
      try {
        const now = new Date().toISOString();
        // Upsert both tables so they stay in sync and user is guaranteed to exist
        await supabase
          .from('users')
          .upsert({
            telegram_id: ctx.from.id,
            wallet_address: input,
            onboarded_at: now,
            updated_at: now,
            ...(ctx.from.username ? { username: ctx.from.username } : {})
          }, { onConflict: 'telegram_id' });

        // Also upsert into user_wallets so the linked address is stored there too
        await supabase
          .from('user_wallets')
          .upsert({
            telegram_id: ctx.from.id,
            public_address: input,
            encrypted_private_key: '',
            updated_at: now
          }, { onConflict: 'telegram_id' });

        onboardingStates.delete(ctx.from.id);
        return ctx.reply(`✅ Wallet successfully linked: \`${input}\``, { parse_mode: 'Markdown' });
      } catch (err: any) {
        console.error('Error linking wallet:', err.message);
        return ctx.reply('❌ Database error. Please try again later.');
      }
    } else {
      return ctx.reply('❌ Invalid format. Please send a valid EVM address (e.g., 0x...).');
    }
  }

  if (message.text.startsWith('/')) return next();

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
// LIGHTWEIGHT EXPRESS HTTP SERVER FOR RENDER / 24/7 & WEBAPP
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// CORS & Preflight Handling (Restricted Origins)
const ALLOWED_ORIGINS = [
  process.env.WEBAPP_URL?.replace(/\/$/, ''),
  'https://wifhpaws-bot.onrender.com',
].filter(Boolean) as string[];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (process.env.WEBAPP_URL) {
    res.header('Access-Control-Allow-Origin', process.env.WEBAPP_URL);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-telegram-init-data');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Helper: Telegram WebApp HMAC SHA-256 Authentication
function validateTelegramInitData(initDataString: string, botToken: string): { valid: boolean; user?: any } {
  if (!initDataString || !botToken) return { valid: false };
  try {
    const urlParams = new URLSearchParams(initDataString);
    const hash = urlParams.get('hash');
    if (!hash) return { valid: false };
    urlParams.delete('hash');

    const params: string[] = [];
    urlParams.forEach((val, key) => {
      params.push(`${key}=${val}`);
    });
    params.sort();
    const dataCheckString = params.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash === hash) {
      const userStr = urlParams.get('user');
      const user = userStr ? JSON.parse(userStr) : undefined;
      return { valid: true, user };
    }
  } catch (err) {
    console.error('[HMAC Auth Error]', err);
  }
  return { valid: false };
}

app.get('/ping', (req, res) => {
  res.send('OK');
});

// Root Route (/) - Returns status 200 to keep Render service awake 24/7 and serves Mini App
app.get(['/', '/index.html'], (req, res) => {
  const indexPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.status(200).sendFile(indexPath);
  }
  return res.status(200).json({ status: 'healthy', bot: 'WifhPaws' });
});

// Health Check Route (/health)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    bot: 'WifhPaws',
    timestamp: new Date().toISOString(),
  });
});

// Admin Panel (/admin)
app.get('/admin', (req, res) => {
  const adminPath = path.join(process.cwd(), 'admin.html');
  if (fs.existsSync(adminPath)) {
    let html = fs.readFileSync(adminPath, 'utf8');
    // Inject runtime Supabase credentials
    html = html
      .replace('__SUPABASE_URL__', process.env.SUPABASE_URL || '')
      .replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);
  } else {
    return res.status(404).send('Admin panel not found.');
  }
});

// WifhPaws Hatchery Mini-App (/hatchery)
app.get('/hatchery', (req, res) => {
  const hatcheryPath = path.join(process.cwd(), 'public', 'hatchery.html');
  if (fs.existsSync(hatcheryPath)) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).sendFile(hatcheryPath);
  } else {
    return res.status(404).send('Hatchery not found.');
  }
});

// Cache Refresh API
app.get('/api/refresh-cache', async (req, res) => {
  try {
    await refreshTriggerCache();
    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error('[API Error /refresh-cache]:', err);
    return res.status(500).json({ success: false, error: 'Failed to refresh cache. Please try again.' });
  }
});

// Admin Check API
app.get('/api/is-admin', async (req, res) => {
  try {
    const telegramId = Number(req.query.telegram_id);
    console.log(`[API /is-admin] telegramId=${telegramId}`);
    const legacyAdmin = telegramId > 0 && isAdmin(telegramId);
    const rbacAdmin = telegramId > 0 && (await hasAnyRbacRole(telegramId));
    const adminCheck = legacyAdmin || rbacAdmin;
    console.log(`[API /is-admin] legacyAdmin=${legacyAdmin}, rbacAdmin=${rbacAdmin}, result=${adminCheck}`);
    return res.status(200).json({ is_admin: adminCheck });
  } catch (err) {
    console.error('[API Error /is-admin]:', err);
    return res.status(200).json({ is_admin: false });
  }
});

// Balance API
app.get('/api/balance', async (req, res) => {
  try {
    const telegramId = Number(req.query.telegram_id);
    const mode = req.query.mode as string | undefined;

    if (!telegramId || !Number.isFinite(telegramId) || telegramId <= 0) {
      return res.status(400).json({ success: false, error: 'Missing or invalid telegram_id' });
    }

    const initData = (req.headers['x-telegram-init-data'] || req.query.initData) as string | undefined;
    if (initData && BOT_TOKEN) {
      const auth = validateTelegramInitData(initData, BOT_TOKEN);
      if (!auth.valid || (auth.user && auth.user.id !== telegramId)) {
        return res.status(401).json({ success: false, error: 'Unauthorized Telegram WebApp session' });
      }
    }

    let address = '';
    if (mode === 'treasury') {
      if (!(await isSuperAdminOrHigherRBAC(telegramId))) {
        return res.status(403).json({ success: false, error: 'Unauthorized. Admins only.' });
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

    return res.status(200).json({
      success: true,
      address: address,
      eth_balance: ethBalance,
      wifh_balance: wifhBalance,
      eth_price_usd: ethPrice,
      wifh_price_usd: wifhPriceUsd,
      pool_rate: poolRate,
    });
  } catch (err: any) {
    console.error('[API Error /balance]:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve balance. Please try again.' });
  }
});

// Swap API
app.post('/api/swap', async (req, res) => {
  try {
    const payload = req.body || {};
    const telegramId = Number(payload.telegram_id);
    const mode = payload.mode;
    const fromToken = String(payload.from || '').toLowerCase();
    const toToken = String(payload.to || '').toLowerCase();
    const amount = Number(payload.amount);

    if (!telegramId || !Number.isFinite(telegramId) || telegramId <= 0 || !Number.isFinite(amount) || amount <= 0 || !['wifh', 'eth'].includes(fromToken) || !['wifh', 'eth'].includes(toToken)) {
      return res.status(400).json({ success: false, error: 'Invalid swap payload parameters' });
    }

    const initData = (req.headers['x-telegram-init-data'] || payload.initData) as string | undefined;
    if (initData && BOT_TOKEN) {
      const auth = validateTelegramInitData(initData, BOT_TOKEN);
      if (!auth.valid || (auth.user && auth.user.id !== telegramId)) {
        return res.status(401).json({ success: false, error: 'Unauthorized Telegram WebApp session' });
      }
    }

    let result;
    if (mode === 'treasury') {
      if (!(await isSuperAdminOrHigherRBAC(telegramId))) {
        return res.status(403).json({ success: false, error: 'Unauthorized. Admins only.' });
      }
      if (!treasurySigner) throw new Error('Treasury not configured');
      result = await executeOnChainSwap(null, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount, treasurySigner);
    } else {
      const userWallet = await getOrCreateWallet(telegramId);
      result = await executeOnChainSwap(userWallet, fromToken as 'eth' | 'wifh', toToken as 'eth' | 'wifh', amount);
    }

    return res.status(200).json({
      success: true,
      received: result.received,
      received_usd: result.receivedUsd,
      tx_hash: result.txHash,
    });
  } catch (err: any) {
    console.error('[API Error /swap]:', err);
    return res.status(500).json({ success: false, error: 'Swap transaction failed. Please try again.' });
  }
});

// Static files in /public
app.use('/public', express.static(path.join(process.cwd(), 'public')));

// 404 handler
app.use((req, res) => {
  res.status(404).send('Not Found');
});

const server = app.listen(port, () => {
  console.log(`[Express] HTTP server listening on port ${port} (Render keep-alive & WebApp)`);
});
// ==========================================
// ==========================================
// TRIVIA GAME LOOP
// ==========================================
import { getQuestionCount, setQuestionCount } from './services/triviaService';
import { airdropToWinners, PayoutConfig } from './services/triviaPayoutService';
import { getOrCreateUser } from './supabase';

interface TriviaSession {
  chatId: number;
  questions: any[];
  currentIdx: number;
  scores: Record<number, { name: string; score: number; wallet: string; userId?: number }>;
  guessedUsers: Set<number>;
  messageId?: number;
  timer?: NodeJS.Timeout;
  acceptingAnswers?: boolean;
  roundWinners?: Array<{ userId: number; name: string; wallet: string }>;
}
const activeTriviaGames = new Map<number, TriviaSession>();

interface PendingWinner {
  place: number;
  userId?: number;
  name: string;
  wallet: string;
}

const pendingTriviaWinners = new Map<number, PendingWinner[]>();

bot.command('stop_trivia', async (ctx) => {
  if (!(await isModOrHigher(ctx.from!.id))) return ctx.reply('⛔ Only admins can stop a trivia game.');
  
  const session = activeTriviaGames.get(ctx.chat.id);
  if (!session) {
    return ctx.reply('ℹ️ There is no active trivia game to stop.');
  }

  clearTimeout(session.timer);
  activeTriviaGames.delete(ctx.chat.id);
  
  await ctx.reply('🛑 *Trivia Game Stopped early by an admin.*', { parse_mode: 'Markdown' });
});

async function startTriviaGame(
  ctx: any,
  category: TriviaCategory = getActiveTriviaCategory()
) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (ctx.chat?.type === 'private') {
    return ctx.reply(
      '⚠️ *Trivia games can only be played in group chats!*\n\n' +
      'Please run `/start_trivia` inside your community group chat to begin a live session.\n\n' +
      '💡 _You can select the active category anytime in_ `/admin` _→ Trivia Settings._',
      { parse_mode: 'Markdown' }
    );
  }

  if (activeTriviaGames.has(chatId)) {
    return ctx.reply('⚠️ A trivia game is already running in this chat!');
  }

  const categoryName = category === 'crypto_wifh' ? 'Crypto & $WIFH Lore' : 'General Knowledge';

  try {
    const questionCount = await getQuestionCount();
    const questions = getTriviaQuestionsByCategory(category, questionCount);

    if (!questions || questions.length === 0) {
      return ctx.reply(`❌ No questions found for category: ${categoryName}`);
    }

    const session: TriviaSession = {
      chatId,
      questions,
      currentIdx: 0,
      scores: {},
      guessedUsers: new Set(),
      acceptingAnswers: false,
      roundWinners: []
    };
    activeTriviaGames.set(chatId, session);

    const startText =
      `🧠 *Trivia Game Started!* 🧠\n\n` +
      `📂 *Category:* ${categoryName}\n` +
      `📋 *Questions:* ${questions.length}\n` +
      `⏱️ *Time per question:* 30 seconds\n\n` +
      `_Everyone who answers correctly earns 1 point!_\n\n` +
      `Get ready for Question 1...`;

    await ctx.reply(startText, { parse_mode: 'Markdown' });

    setTimeout(() => sendNextTriviaQuestion(ctx), 3000);
  } catch (err: any) {
    console.error('[Trivia] startTriviaGame error:', err);
    await ctx.reply('❌ Failed to start trivia. Please try again later.');
  }
}

bot.command('start_trivia', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply(
      '⚠️ *Trivia games can only be played in group chats!*\n\n' +
      'Please run `/start_trivia` inside your community group chat to begin a live session.\n\n' +
      '💡 _You can select the active category anytime in_ `/admin` _→ Trivia Settings._',
      { parse_mode: 'Markdown' }
    );
  }

  if (!(await isModOrHigher(ctx.from!.id))) return ctx.reply('⛔ Only admins can start a trivia game.');
  
  if (activeTriviaGames.has(ctx.chat.id)) {
    return ctx.reply('⚠️ A trivia game is already running in this chat!');
  }

  const text = (ctx.message as any)?.text || '';
  const args = text.trim().split(/\s+/).slice(1);
  const arg = (args[0] || '').toLowerCase();

  let category: TriviaCategory = getActiveTriviaCategory();
  if (arg === 'lore' || arg === 'crypto' || arg === 'wifh') {
    category = 'crypto_wifh';
  } else if (arg === 'gk' || arg === 'general' || arg === 'knowledge') {
    category = 'general_knowledge';
  }

  return startTriviaGame(ctx, category);
});

async function sendNextTriviaQuestion(ctx: any) {
  const session = activeTriviaGames.get(ctx.chat.id);
  if (!session) return;

  if (session.currentIdx >= session.questions.length) {
    return endTriviaGame(ctx);
  }

  const q = session.questions[session.currentIdx];
  session.guessedUsers.clear();
  session.roundWinners = [];
  session.acceptingAnswers = true;

  const keyboard = q.options.map((opt: string, idx: number) => {
    return [{ text: opt, callback_data: `tq_${idx}` }];
  });

  const msg = await ctx.reply(`📝 *Question ${session.currentIdx + 1} of ${session.questions.length}:* (⏳ 30s)\n\n${q.question}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });

  session.messageId = msg.message_id;

  session.timer = setTimeout(async () => {
    session.acceptingAnswers = false;

    // Credit points to all players who answered correctly during this round
    const winners = session.roundWinners || [];
    for (const w of winners) {
      if (!session.scores[w.userId]) {
        session.scores[w.userId] = {
          name: w.name,
          score: 0,
          wallet: w.wallet,
          userId: w.userId
        };
      }
      session.scores[w.userId].score += 1;
    }

    let recapText = `⏰ *Time's up!*\n\nThe correct answer was: *${q.options[q.correctOptionId]}*\n\n`;
    if (winners.length > 0) {
      const winnerList = winners.map(w => `• ${w.name}`).join('\n');
      recapText += `🎯 *Correct answers (${winners.length}):*\n${winnerList}\n\n_+1 point awarded to each!_`;
    } else {
      recapText += `😢 *Nobody answered correctly!*`;
    }

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, session.messageId, undefined, recapText, { parse_mode: 'Markdown' });
    } catch (editErr: any) {
      console.warn('[trivia] Failed to edit question message on timeout:', editErr?.message || editErr);
    }

    session.currentIdx++;
    setTimeout(() => sendNextTriviaQuestion(ctx), 4000);
  }, 30000);
}

bot.action(/tq_(\d+)/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = activeTriviaGames.get(chatId);
  if (!session) {
    return ctx.answerCbQuery('No active trivia game!');
  }

  if (!session.acceptingAnswers) {
    return ctx.answerCbQuery('⏰ Time is up for this question!');
  }

  const userId = ctx.from!.id;
  if (session.guessedUsers.has(userId)) {
    return ctx.answerCbQuery('You already submitted an answer for this question!');
  }

  const chosenIdx = parseInt(ctx.match[1]);
  const q = session.questions[session.currentIdx];

  session.guessedUsers.add(userId);

  if (chosenIdx === q.correctOptionId) {
    const playerName = ctx.from!.username ? `@${ctx.from!.username}` : (ctx.from!.first_name || 'Player');
    let wallet = '';
    try {
      const dbUser = await getOrCreateUser(userId, ctx.from!.username || ctx.from!.first_name || 'Player');
      wallet = dbUser?.wallet_address || '';
    } catch (dbErr) {
      console.warn('[trivia] Error fetching user wallet:', dbErr);
    }

    if (!session.roundWinners) session.roundWinners = [];
    session.roundWinners.push({
      userId,
      name: playerName,
      wallet
    });

    await ctx.answerCbQuery('🎉 Correct! Point recorded.');
  } else {
    await ctx.answerCbQuery('❌ Wrong answer!');
  }
});

async function endTriviaGame(ctx: any) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // ── Phase 1: Extract session and clean up ──
  const session = activeTriviaGames.get(chatId);
  if (!session) return;
  activeTriviaGames.delete(chatId);

  const scoreEntries = Object.entries(session.scores);

  // Edge-case: nobody answered correctly
  if (!scoreEntries || scoreEntries.length === 0) {
    try {
      await ctx.reply('🏁 *Trivia Finished!*\n\nNobody scored any points! 😢', { parse_mode: 'Markdown' });
    } catch (msgErr: any) {
      console.error('[endTriviaGame] Failed to send empty-scores message:', msgErr?.message || msgErr);
    }
    return;
  }

  // ── Phase 2: Sort scores & build winner cache ──
  let sortedScores: Array<{ keyUserId: number; name: string; score: number; wallet: string; userId?: number }> = [];
  const pending: PendingWinner[] = [];

  try {
    sortedScores = scoreEntries
      .map(([keyIdStr, item]) => ({
        keyUserId: Number(keyIdStr) || 0,
        name: item?.name || 'Player',
        score: item?.score || 0,
        wallet: item?.wallet || '',
        userId: item?.userId,
      }))
      .sort((a, b) => b.score - a.score);

    sortedScores.slice(0, 3).forEach((p, idx) => {
      pending.push({
        place: idx + 1,
        userId: p.userId && p.userId > 0 ? p.userId : (p.keyUserId || 0),
        name: p.name || 'Player',
        wallet: typeof p.wallet === 'string' ? p.wallet : '',
      });
    });
  } catch (sortErr: any) {
    console.error('[endTriviaGame] Error sorting scores / building winners:', sortErr?.message || sortErr);
  }

  // ── Phase 3: Cache pending winners (must succeed before messages) ──
  try {
    if (pending.length > 0) {
      pendingTriviaWinners.set(chatId, pending);
    }
  } catch (cacheErr: any) {
    console.error('[endTriviaGame] Error caching pendingTriviaWinners:', cacheErr?.message || cacheErr);
  }

  // ── Phase 4: Send final leaderboard ──
  try {
    let text = '🏁 *Trivia Finished! Here are the final scores:*\n\n';
    sortedScores.forEach((p, idx) => {
      let medal = '';
      if (idx === 0) medal = '🥇';
      else if (idx === 1) medal = '🥈';
      else if (idx === 2) medal = '🥉';
      text += `${medal ? medal + ' ' : ''}${idx + 1}. ${p.name} - ${p.score} pts\n`;
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (leaderErr: any) {
    console.error('[endTriviaGame] Error sending leaderboard:', leaderErr?.message || leaderErr);
  }

  // ── Phase 5: Send pending-winners notification ──
  try {
    if (pending.length > 0) {
      let pendingText = `🏆 *Pending Trivia Winners Recorded!*\n\n`;
      pending.forEach((w) => {
        const medal = w.place === 1 ? '🥇' : (w.place === 2 ? '🥈' : '🥉');
        pendingText += `${medal} *${w.place} Place:* ${w.name}\n`;
      });
      pendingText += `\n✅ *Ready to distribute!*`;

      await ctx.reply(pendingText, { parse_mode: 'Markdown' });
    }
  } catch (notifyErr: any) {
    console.error('[endTriviaGame] Error sending pending-winners notification:', notifyErr?.message || notifyErr);
  }
}

// Command: /payout — Execute payout using predetermined config amounts
bot.command(['payout', `payout@${BOT_USERNAME}`], async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !(await isModOrHigher(senderId))) {
    return ctx.reply('⛔ Unauthorized. Only admins can execute trivia payouts.');
  }

  const pending = pendingTriviaWinners.get(ctx.chat.id);
  if (!pending || pending.length === 0) {
    // No pending winners — just show the dashboard info
    try {
      const cfg = await getPayoutConfig();
      let text = `💰 *Trivia Payout Dashboard*\n\n`;
      text += `🏆 *Configured Rewards (per game):*\n`;
      text += `🥇 1st Place: *${cfg.first} WIFH*\n`;
      text += `🥈 2nd Place: *${cfg.second} WIFH*\n`;
      text += `🥉 3rd Place: *${cfg.third} WIFH*\n\n`;
      text += `ℹ️ _No pending trivia winners in this chat._`;
      return ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err: any) {
      console.error('[/payout Error]:', err?.message || err);
      return ctx.reply('❌ Failed to load payout information. Please try again.');
    }
  }

  // Pending winners exist — execute payout using config defaults
  let amounts: number[] = [];
  try {
    const cfg = await getPayoutConfig();
    if (cfg.first > 0) amounts.push(cfg.first);
    if (cfg.second > 0) amounts.push(cfg.second);
    if (cfg.third > 0) amounts.push(cfg.third);
  } catch (cfgErr: any) {
    console.error('[Payout Config Fetch Error]:', cfgErr?.message || cfgErr);
  }

  if (amounts.length === 0) {
    return ctx.reply(
      '⚠️ *No default reward amounts configured.*\n\n' +
      'Please set default rewards in the Admin Panel → 🎮 Trivia Settings,\n' +
      'or use `/payout_trivia <1st> [2nd] [3rd]` to specify amounts manually.',
      { parse_mode: 'Markdown' }
    );
  }

  // Show config being used
  let configText = `💰 *Paying out using configured rewards:*\n`;
  configText += `🥇 1st: ${amounts[0] || 0} WIFH`;
  if (amounts[1]) configText += ` | 🥈 2nd: ${amounts[1]} WIFH`;
  if (amounts[2]) configText += ` | 🥉 3rd: ${amounts[2]} WIFH`;
  configText += `\n\n⏳ *Pending Winners:*\n`;
  pending.forEach((w) => {
    const medal = w.place === 1 ? '🥇' : (w.place === 2 ? '🥈' : '🥉');
    configText += `${medal} ${w.name}\n`;
  });
  await ctx.reply(configText, { parse_mode: 'Markdown' });

  const statusMsg = await ctx.reply('⏳ Processing trivia payouts from Treasury...');

  try {
    const receiptLines: string[] = [];
    const pConfig: PayoutConfig = {
      first: amounts[0] || 0,
      second: amounts[1] || 0,
      third: amounts[2] || 0,
    };

    if (treasurySigner && WIFH_CONTRACT_ADDRESS) {
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
      const decimals = await contract.decimals();

      for (let i = 0; i < pending.length && i < amounts.length; i++) {
        const winner = pending[i];
        const tokenAmount = amounts[i];
        if (tokenAmount <= 0) continue;

        const medal = winner.place === 1 ? '🥇' : (winner.place === 2 ? '🥈' : '🥉');

        let targetAddress = winner.wallet;
        if ((!targetAddress || !(ethers.isAddress as any)(targetAddress)) && winner.userId && winner.userId > 0) {
          try {
            const w = await getOrCreateWallet(winner.userId);
            targetAddress = w?.public_address || '';
          } catch (e) {
            targetAddress = '';
          }
        }
        if ((!targetAddress || !(ethers.isAddress as any)(targetAddress)) && winner.name) {
          try {
            const cleanUsername = winner.name.replace('@', '').trim();
            const { data: dbUser } = await supabase
              .from('users')
              .select('telegram_id')
              .ilike('username', cleanUsername)
              .maybeSingle();
            if (dbUser && dbUser.telegram_id) {
              const w = await getOrCreateWallet(dbUser.telegram_id);
              targetAddress = w?.public_address || '';
            }
          } catch (e) {
            targetAddress = '';
          }
        }

        if (targetAddress && (ethers.isAddress as any)(targetAddress)) {
          const userAmount = ethers.parseUnits(tokenAmount.toString(), decimals);
          const feeAmount = userAmount / BigInt(100);
          const totalRequired = userAmount + feeAmount;

          const treasuryBalance = await contract.balanceOf(treasurySigner.address);
          if (treasuryBalance >= totalRequired) {
            const txUser = await contract.transfer(targetAddress, userAmount);
            await txUser.wait();
            if (feeAmount > 0n) {
              await dispatchFeesToDevWallet(feeAmount, contract, treasurySigner);
            }
            receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH*`);
          } else {
            receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH* (⚠️ Insufficient Treasury Balance)`);
          }
        } else {
          receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH* (⚠️ No Wallet Linked)`);
        }
      }
    } else {
      await airdropToWinners(pending, pConfig);
      pending.forEach((w, idx) => {
        const amt = amounts[idx] || 0;
        if (amt > 0) {
          const medal = w.place === 1 ? '🥇' : (w.place === 2 ? '🥈' : '🥉');
          receiptLines.push(`${medal} ${w.name}: *${amt} WIFH*`);
        }
      });
    }

    pendingTriviaWinners.delete(ctx.chat.id);

    const receiptText =
      `🎉 *AIRDROP / TRIVIA PAYOUT SUCCESSFUL!*\n\n` +
      receiptLines.join('\n') +
      `\n\n🐾 *The Hood has delivered!*`;

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      receiptText,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    console.error('[Trivia Payout Error]:', err);
    return ctx.reply('❌ Payout failed. Please check treasury balance and try again.');
  }
});

// Command: /payout_trivia <1st_amount> [2nd_amount] [3rd_amount] — Manual amounts payout
bot.command(['payout_trivia', `payout_trivia@${BOT_USERNAME}`], async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !(await isModOrHigher(senderId))) {
    return ctx.reply('⛔ Unauthorized. Only admins can execute trivia payouts.');
  }

  const pending = pendingTriviaWinners.get(ctx.chat.id);
  if (!pending || pending.length === 0) {
    return ctx.reply('⚠️ No pending trivia winners found for this chat. Run a trivia game first with `/start_trivia`.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ').filter(Boolean);

  if (args.length < 2) {
    return ctx.reply(
      '⚠️ *Please specify payout amounts manually:*\n\n' +
      '`/payout_trivia <1st> [2nd] [3rd]`\n\n' +
      '_Example: `/payout_trivia 100 50 25`_\n\n' +
      '_Or use `/payout` to pay using the configured default rewards._',
      { parse_mode: 'Markdown' }
    );
  }

  let amounts: number[] = [];
  for (let i = 1; i < args.length && i <= 3; i++) {
    const val = Number(args[i]);
    if (!Number.isFinite(val) || val <= 0) {
      return ctx.reply(`❌ Invalid amount '${args[i]}'. Please enter positive numerical amounts.`);
    }
    amounts.push(val);
  }

  const statusMsg = await ctx.reply('⏳ Processing trivia payouts from Treasury...');

  try {
    const receiptLines: string[] = [];
    const pConfig: PayoutConfig = {
      first: amounts[0] || 0,
      second: amounts[1] || 0,
      third: amounts[2] || 0,
    };

    if (treasurySigner && WIFH_CONTRACT_ADDRESS) {
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
      const decimals = await contract.decimals();

      for (let i = 0; i < pending.length && i < amounts.length; i++) {
        const winner = pending[i];
        const tokenAmount = amounts[i];
        if (tokenAmount <= 0) continue;

        const medal = winner.place === 1 ? '🥇' : (winner.place === 2 ? '🥈' : '🥉');

        let targetAddress = winner.wallet;
        if ((!targetAddress || !(ethers.isAddress as any)(targetAddress)) && winner.userId && winner.userId > 0) {
          try {
            const w = await getOrCreateWallet(winner.userId);
            targetAddress = w?.public_address || '';
          } catch (e) {
            targetAddress = '';
          }
        }
        if ((!targetAddress || !(ethers.isAddress as any)(targetAddress)) && winner.name) {
          try {
            const cleanUsername = winner.name.replace('@', '').trim();
            const { data: dbUser } = await supabase
              .from('users')
              .select('telegram_id')
              .ilike('username', cleanUsername)
              .maybeSingle();
            if (dbUser && dbUser.telegram_id) {
              const w = await getOrCreateWallet(dbUser.telegram_id);
              targetAddress = w?.public_address || '';
            }
          } catch (e) {
            targetAddress = '';
          }
        }

        if (targetAddress && (ethers.isAddress as any)(targetAddress)) {
          const userAmount = ethers.parseUnits(tokenAmount.toString(), decimals);
          const feeAmount = userAmount / BigInt(100);
          const totalRequired = userAmount + feeAmount;

          const treasuryBalance = await contract.balanceOf(treasurySigner.address);
          if (treasuryBalance >= totalRequired) {
            const txUser = await contract.transfer(targetAddress, userAmount);
            await txUser.wait();
            if (feeAmount > 0n) {
              await dispatchFeesToDevWallet(feeAmount, contract, treasurySigner);
            }
            receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH*`);
          } else {
            receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH* (⚠️ Insufficient Treasury Balance)`);
          }
        } else {
          receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH* (⚠️ No Wallet Linked)`);
        }
      }
    } else {
      await airdropToWinners(pending, pConfig);
      pending.forEach((w, idx) => {
        const amt = amounts[idx] || 0;
        if (amt > 0) {
          const medal = w.place === 1 ? '🥇' : (w.place === 2 ? '🥈' : '🥉');
          receiptLines.push(`${medal} ${w.name}: *${amt} WIFH*`);
        }
      });
    }

    pendingTriviaWinners.delete(ctx.chat.id);

    const receiptText =
      `🎉 *AIRDROP / TRIVIA PAYOUT SUCCESSFUL!*\n\n` +
      receiptLines.join('\n') +
      `\n\n🐾 *The Hood has delivered!*`;

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      receiptText,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    console.error('[Trivia Payout Error]:', err);
    return ctx.reply('❌ Payout failed. Please check treasury balance and try again.');
  }
});

// Command: /payout_scramble <1st_amount> [2nd_amount] [3rd_amount]
bot.command(['payout_scramble', `payout_scramble@${BOT_USERNAME}`], async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !(await isModOrHigher(senderId))) {
    return ctx.reply('⛔ Unauthorized. Only admins can execute scramble payouts.');
  }

  const pending = pendingScrambleWinners.get(ctx.chat.id);
  if (!pending || pending.length === 0) {
    return ctx.reply('⚠️ No pending scramble winners found for this chat. Run a scramble game first with `/start_scramble`.', { parse_mode: 'Markdown' });
  }

  const args = (ctx.message as any).text.split(' ').filter(Boolean);
  
  let pConfig: any;
  let amounts: number[] = [];

  if (args.length >= 2) {
    // Manual amounts
    for (let i = 1; i < args.length && i <= 3; i++) {
      const val = Number(args[i]);
      if (!Number.isFinite(val) || val <= 0) {
        return ctx.reply(`❌ Invalid amount '${args[i]}'. Please enter positive numerical amounts.`);
      }
      amounts.push(val);
    }
    pConfig = { first: amounts[0] || 0, second: amounts[1] || 0, third: amounts[2] || 0 };
  } else {
    // Use config
    pConfig = await getScramblePayoutConfig();
    amounts = [pConfig.first, pConfig.second, pConfig.third];
  }

  const statusMsg = await ctx.reply('⏳ Processing scramble payouts from Treasury...');

  try {
    const receiptLines: string[] = [];

    if (treasurySigner && WIFH_CONTRACT_ADDRESS) {
      const contract = new ethers.Contract(WIFH_CONTRACT_ADDRESS, ERC20_ABI, treasurySigner);
      const decimals = await contract.decimals();

      for (let i = 0; i < pending.length && i < amounts.length; i++) {
        const winner = pending[i];
        const tokenAmount = amounts[i];
        if (tokenAmount <= 0) continue;

        const medal = winner.place === 1 ? '🥇' : (winner.place === 2 ? '🥈' : '🥉');

        let targetAddress = winner.wallet;
        if ((!targetAddress || !(ethers.isAddress as any)(targetAddress)) && winner.userId && winner.userId > 0) {
          try {
            const w = await getOrCreateWallet(winner.userId);
            targetAddress = w?.public_address || '';
          } catch (e) {
            targetAddress = '';
          }
        }
        if ((!targetAddress || !(ethers.isAddress as any)(targetAddress)) && winner.name) {
          try {
            const cleanUsername = winner.name.replace('@', '').trim();
            const { data: dbUser } = await supabase
              .from('users')
              .select('telegram_id')
              .ilike('username', cleanUsername)
              .maybeSingle();
            if (dbUser && dbUser.telegram_id) {
              const w = await getOrCreateWallet(dbUser.telegram_id);
              targetAddress = w?.public_address || '';
            }
          } catch (e) {
            targetAddress = '';
          }
        }

        if (targetAddress && (ethers.isAddress as any)(targetAddress)) {
          const userAmount = ethers.parseUnits(tokenAmount.toString(), decimals);
          const feeAmount = userAmount / BigInt(100); // 1% fee
          const totalRequired = userAmount + feeAmount;

          const treasuryBalance = await contract.balanceOf(treasurySigner.address);
          if (treasuryBalance >= totalRequired) {
            const txUser = await contract.transfer(targetAddress, userAmount);
            await txUser.wait();
            if (feeAmount > 0n) {
              await dispatchFeesToDevWallet(feeAmount, contract, treasurySigner);
            }
            receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH*`);
          } else {
            receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH* (⚠️ Insufficient Treasury Balance)`);
          }
        } else {
          receiptLines.push(`${medal} ${winner.name}: *${tokenAmount} WIFH* (⚠️ No Wallet Linked)`);
        }
      }
    } else {
      await airdropToWinners(pending as any, pConfig);
      pending.forEach((w, idx) => {
        const amt = amounts[idx] || 0;
        if (amt > 0) {
          const medal = w.place === 1 ? '🥇' : (w.place === 2 ? '🥈' : '🥉');
          receiptLines.push(`${medal} ${w.name}: *${amt} WIFH*`);
        }
      });
    }

    pendingScrambleWinners.delete(ctx.chat.id);

    const receiptText =
      `🎉 *SCRAMBLE PAYOUT SUCCESSFUL!*\n\n` +
      receiptLines.join('\n') +
      `\n\n🐾 *The Hood has delivered!*`;

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      receiptText,
      { parse_mode: 'Markdown' }
    );
  } catch (err: any) {
    console.error('[Scramble Payout Error]:', err);
    return ctx.reply('❌ Payout failed. Please check treasury balance and try again.');
  }
});

// Command: /skip_payout
bot.command(['skip_payout', `skip_payout@${BOT_USERNAME}`], async (ctx) => {
  const senderId = ctx.from?.id;
  if (!senderId || !(await isModOrHigher(senderId))) {
    return ctx.reply('⛔ Unauthorized.');
  }

  if (!pendingTriviaWinners.has(ctx.chat.id)) {
    return ctx.reply('ℹ️ No pending trivia payout found for this chat.');
  }

  pendingTriviaWinners.delete(ctx.chat.id);
  return ctx.reply('🗑️ *Pending trivia payout cleared.* No rewards were distributed for this round.', { parse_mode: 'Markdown' });
});

// Launch Bot with Exponential Backoff Retry Logic
async function launchBotWithRetry(maxRetries = 5, initialDelayMs = 3000) {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Bot Launch] Attempt ${attempt} of ${maxRetries} connecting to Telegram API...`);
      await bot.launch({ allowedUpdates: ['message', 'callback_query'] });
      console.log('WifhPaws Bot running with secret keywords, treasury dashboard, and WebApp!');
      
      bot.telegram.setMyCommands([
        { command: 'wallet', description: 'Open your Personal Wallet Dashboard' },
        { command: 'leaderboard', description: 'View the top Paw Point holders' },
        { command: 'swap', description: 'Swap between WIFH and ETH' },
        { command: 'send', description: 'Send tokens to someone' },
        { command: 'buy', description: 'Buy WIFH with ETH' },
        { command: 'sell', description: 'Sell WIFH for ETH' },
        { command: 'admin', description: 'Open Admin & Dev Control Panel (Admins)' },
        { command: 'devpanel', description: 'Open Developer & Liquidity Control Panel (Admins)' },
        { command: 'payout', description: 'View trivia reward config & pending winners (Admins)' },
        { command: 'payout_trivia', description: 'Distribute pending trivia rewards (Admins)' },
        { command: 'skip_payout', description: 'Dismiss pending trivia rewards (Admins)' },
        { command: 'initproject', description: 'Bootstrap a project instance (Global Masters)' },
        { command: 'addadmin', description: 'Add a moderator to the project (Owner/Super Admin)' },
        { command: 'promotesuper', description: 'Promote mod to Super Admin (Owner)' },
        { command: 'demote', description: 'Demote Super Admin to mod (Owner)' },
        { command: 'removeadmin', description: 'Remove admin privileges (Owner)' },
        { command: 'roles', description: 'List all project staff roles' },
        { command: 'myrole', description: 'Check your role in this project' },
        { command: 'selectproject', description: 'Switch active project for DM management' },
        { command: 'rbachelp', description: 'View RBAC role hierarchy & commands' },
      ]).catch(err => console.error('Failed to set commands menu:', err));

      return;
    } catch (err: any) {
      console.error(`[Bot Launch Error] Attempt ${attempt} failed: ${err?.message || err}`);
      if (attempt < maxRetries) {
        console.log(`[Bot Launch] Retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 1.5;
      } else {
        console.error('[Bot Launch Failed] Maximum launch retries reached. Express server remains active for health checks.');
      }
    }
  }
}

setupScrambleGame(bot, isModOrHigher);

launchBotWithRetry();

const stopBot = (signal: string) => {
  console.log(`\nReceived ${signal}. Stopping bot...`);
  try {
    server.close();
    bot.stop(signal);
  } catch (e: any) {
    console.error('Error during graceful shutdown:', e?.message || e);
  }
  process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
