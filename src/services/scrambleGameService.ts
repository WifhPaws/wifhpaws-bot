import fs from 'fs';
import path from 'path';
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { getOrCreateUser } from '../supabase';
import { supabase } from '../db/supabaseClient';

export interface ScramblePayoutConfig {
  first: number;
  second: number;
  third: number;
}

export const setScramblePayoutConfig = async (first: number, second: number, third: number): Promise<void> => {
  const { error } = await supabase
    .from('trivia_payouts')
    .upsert({ id: 2, first_amount: first, second_amount: second, third_amount: third }, { onConflict: 'id' });
  if (error) throw error;
};

export const getScramblePayoutConfig = async (): Promise<ScramblePayoutConfig> => {
  const { data, error } = await supabase
    .from('trivia_payouts')
    .select('first_amount, second_amount, third_amount')
    .eq('id', 2)
    .maybeSingle();
  if (error) {
    console.warn('Failed to fetch scramble payouts:', error.message);
    return { first: 0, second: 0, third: 0 };
  }
  return {
    first: Number(data?.first_amount ?? 0),
    second: Number(data?.second_amount ?? 0),
    third: Number(data?.third_amount ?? 0),
  };
};
interface ScrambleWord {
  word: string;
  hint: string;
}

interface ScrambleBank {
  words: ScrambleWord[];
}

interface ScrambleSession {
  chatId: number;
  currentRound: number;
  maxRounds: number;
  scores: Record<number, { name: string; score: number; wallet: string }>;
  currentWord: string;
  currentHint: string;
  scrambled: string;
  timer: NodeJS.Timeout | null;
  messageId?: number;
  acceptingAnswers: boolean;
  usedWords: Set<string>;
  startTime: number;
  roundWinners: { userId: number; name: string; timeTakenSec: number; wallet: string }[];
  graceTimer?: NodeJS.Timeout | null;
}

const activeScrambleGames = new Map<number, ScrambleSession>();

export interface PendingScrambleWinner {
  place: number;
  userId: number;
  name: string;
  wallet: string;
}

export const pendingScrambleWinners = new Map<number, PendingScrambleWinner[]>();


// Load the word bank
function loadWordBank(): ScrambleWord[] {
  const p = path.resolve(process.cwd(), 'src', 'data', 'scramble-bank.json');
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const data: ScrambleBank = JSON.parse(raw);
    return data.words;
  } catch (error) {
    console.error('[Scramble] Error reading scramble-bank.json', error);
    return [];
  }
}

const wordBank = loadWordBank();

function shuffleWord(word: string): string {
  const arr = word.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

export function setupScrambleGame(bot: Telegraf, isModOrHigher: (userId: number) => Promise<boolean>) {
  
  // Command to start
  bot.command('start_scramble', async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('⚠️ *Scramble games can only be played in group chats!*', { parse_mode: 'Markdown' });
    }

    const senderId = ctx.from?.id;
    if (!senderId || !(await isModOrHigher(senderId))) {
      return ctx.reply('⛔ Only admins can start a scramble game.');
    }

    if (activeScrambleGames.has(ctx.chat.id)) {
      return ctx.reply('⚠️ A scramble game is already running in this chat!');
    }

    if (wordBank.length === 0) {
      return ctx.reply('❌ No words found in the scramble bank.');
    }

    const session: ScrambleSession = {
      chatId: ctx.chat.id,
      currentRound: 0,
      maxRounds: 5,
      scores: {},
      currentWord: '',
      currentHint: '',
      scrambled: '',
      timer: null,
      acceptingAnswers: false,
      usedWords: new Set(),
      startTime: 0,
      roundWinners: []
    };

    activeScrambleGames.set(ctx.chat.id, session);

    const startText = 
      `🧢 HOODIE'S CIPHER STARTED! 🧢\n\n` +
      `📋 Rounds: 5\n` +
      `⏱️ Time per word: 30 seconds\n\n` +
      `_Top 3 fastest answers win points! (7s grace period)_\n\n` +
      `Get ready for Round 1...`;

    await ctx.reply(startText, { parse_mode: 'Markdown' });

    setTimeout(() => sendNextScrambleWord(ctx, session), 3000);
  });

  // Command to stop early
  bot.command('stop_scramble', async (ctx) => {
    if (!(await isModOrHigher(ctx.from!.id))) return ctx.reply('⛔ Only admins can stop a scramble game.');
    
    const session = activeScrambleGames.get(ctx.chat.id);
    if (!session) {
      return ctx.reply('ℹ️ There is no active scramble game to stop.');
    }

    if (session.timer) clearTimeout(session.timer);
    if (session.graceTimer) clearTimeout(session.graceTimer);
    activeScrambleGames.delete(ctx.chat.id);
    
    await ctx.reply('🛑 *Scramble Game Stopped early by an admin.*', { parse_mode: 'Markdown' });
  });

  // Listen for text guesses
  bot.on(message('text'), async (ctx, next) => {
    const chatId = ctx.chat.id;
    const session = activeScrambleGames.get(chatId);

    // If no active game, or not accepting answers, move on
    if (!session || !session.acceptingAnswers) {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      return next();
    }

    // Check if the guess is correct (case-insensitive)
    if (text.toLowerCase() === session.currentWord.toLowerCase()) {
      const userId = ctx.from!.id;
      // Deduplicate user
      if (session.roundWinners.some(w => w.userId === userId)) return next();

      const timeTakenSec = (Date.now() - session.startTime) / 1000;
      const playerName = ctx.from!.username ? `@${ctx.from!.username}` : (ctx.from!.first_name || 'Player');
      
      let wallet = '';
      try {
        const dbUser = await getOrCreateUser(userId, playerName);
        wallet = dbUser?.wallet_address || '';
      } catch (e) {
        console.warn('Could not fetch wallet for user:', e);
      }

      session.roundWinners.push({ userId, name: playerName, timeTakenSec, wallet });

      if (session.roundWinners.length === 1) {
        // Start 7s grace window
        if (session.timer) clearTimeout(session.timer);
        session.graceTimer = setTimeout(() => finalizeScrambleRound(ctx, session), 7000);
      } else if (session.roundWinners.length >= 3) {
        // End immediately when 3rd person gets it
        if (session.graceTimer) clearTimeout(session.graceTimer);
        finalizeScrambleRound(ctx, session);
      }
      return next(); // Still call next so other handlers work
    } else {
      return next();
    }
  });

  async function finalizeScrambleRound(ctx: any, session: ScrambleSession) {
    session.acceptingAnswers = false;
    if (session.timer) clearTimeout(session.timer);
    if (session.graceTimer) clearTimeout(session.graceTimer);

    let winnersText = '';
    
    if (session.roundWinners.length === 0) {
      winnersText = `❌ Time's up! Nobody answered correctly.`;
    } else {
      winnersText = `🏆 WINNERS:\n`;
      const rewards = [50, 25, 10];
      const medals = ['🥇', '🥈', '🥉'];
      session.roundWinners.forEach((w, idx) => {
        const pts = rewards[idx] || 0;
        if (!session.scores[w.userId]) {
          session.scores[w.userId] = { name: w.name, score: 0, wallet: w.wallet };
        }
        session.scores[w.userId].score += pts;
        
        const medal = medals[idx] || '🏅';
        winnersText += `${medal} ${w.name} (+${pts} Pts) — ${w.timeTakenSec.toFixed(1)}s\n`;
      });
    }

    const resultContent = 
      `🧢 HOODIE'S CIPHER • ROUND ${session.currentRound + 1}/${session.maxRounds} CONCLUDED\n\n` +
      `❓ Scramble: ${session.scrambled.toUpperCase()}\n` +
      `✅ Answer: ${session.currentWord.toUpperCase()}\n\n` +
      `${winnersText}`;

    try {
      await ctx.telegram.editMessageText(
        session.chatId,
        session.messageId,
        resultContent
      );
    } catch (error) {}

    session.currentRound++;
    setTimeout(() => sendNextScrambleWord(ctx, session), 4000);
  }

  async function sendNextScrambleWord(ctx: any, session: ScrambleSession) {
    if (session.currentRound >= session.maxRounds) {
      return endScrambleGame(ctx, session);
    }

    session.roundWinners = [];
    
    // Pick a random word not yet used
    let pool = wordBank.filter(w => !session.usedWords.has(w.word));
    if (pool.length === 0) {
      // If we run out, just use all of them again
      pool = wordBank;
      session.usedWords.clear();
    }

    const pick = pool[Math.floor(Math.random() * pool.length)];
    session.usedWords.add(pick.word);
    
    session.currentWord = pick.word;
    session.currentHint = pick.hint;
    // ensure it is really scrambled
    let scrambled = pick.word;
    while (scrambled === pick.word && pick.word.length > 1) {
      scrambled = shuffleWord(pick.word);
    }
    session.scrambled = scrambled;
    session.acceptingAnswers = true;
    session.startTime = Date.now();

    const cleanWord = session.scrambled.toUpperCase().split('').join(' ');

    const msg = await ctx.reply(
      `🧢 HOODIE'S CIPHER • ROUND ${session.currentRound + 1}/${session.maxRounds}\n\n` +
      `❓ Scramble: ${cleanWord}\n` +
      `💡 Hint: ${session.currentHint}\n\n` +
      `⚡ Reward: Top 3 Pts | ⏳ 30s`
    );

    session.messageId = msg.message_id;

    // Set timeout
    session.timer = setTimeout(async () => {
      finalizeScrambleRound(ctx, session);
    }, 30000);
  }

  async function endScrambleGame(ctx: any, session: ScrambleSession) {
    activeScrambleGames.delete(session.chatId);

    const scoreEntries = Object.entries(session.scores);
    if (scoreEntries.length === 0) {
      return ctx.reply(
        `🏁 Scramble Finished!\n\n` +
        `Nobody scored any points! 😢`
      );
    }

    const sortedScores = scoreEntries
      .map(([userIdStr, data]) => ({ userId: Number(userIdStr), ...data }))
      .sort((a, b) => b.score - a.score);

    let text = 
      `🏁 Scramble Game Finished!\n\n` +
      `Final Scores:\n\n`;
    
    const pending: PendingScrambleWinner[] = [];
    sortedScores.forEach((p, idx) => {
      let medal = '';
      if (idx === 0) medal = '🥇';
      else if (idx === 1) medal = '🥈';
      else if (idx === 2) medal = '🥉';
      text += `${medal ? medal + ' ' : ''}${idx + 1}. ${p.name} - ${p.score} pts\n`;

      if (idx < 3) {
        pending.push({
          place: idx + 1,
          userId: p.userId,
          name: p.name,
          wallet: p.wallet,
        });
      }
    });

    if (pending.length > 0) {
      pendingScrambleWinners.set(session.chatId, pending);
      let pendingText = `🏆 *Pending Scramble Winners Recorded!*\n\n`;
      pending.forEach((w) => {
        const medal = w.place === 1 ? '🥇' : (w.place === 2 ? '🥈' : '🥉');
        pendingText += `${medal} *${w.place} Place:* ${w.name}\n`;
      });
      pendingText += `\n✅ *Ready to distribute!*`;
      await ctx.reply(pendingText, { parse_mode: 'Markdown' });
    }

    await ctx.reply(text);
  }
}
