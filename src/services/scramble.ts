import { Telegram } from 'telegraf';

export interface ScrambleWinner {
  userId: number;
  username: string;
  pointsAwarded: number;
  timeTakenSec: number;
}

export interface ActiveScrambleSession {
  chatId: number;
  messageId: number;
  currentRound: number;
  totalRounds: number;
  word: string;
  scrambledWord: string;
  hint: string;
  startTime: number;
  winners: ScrambleWinner[];
  graceTimer?: NodeJS.Timeout;
  roundTimer?: NodeJS.Timeout;
}

export const SCRAMBLE_REWARDS = [
  { rank: 1, points: 50, label: '1st Place' },
  { rank: 2, points: 25, label: '2nd Place' },
  { rank: 3, points: 10, label: '3rd Place' },
];

function formatScrambledWord(word: string): string {
  return word.toUpperCase().split('').join(' ');
}

export function buildScrambleCardMessage(
  round: number,
  totalRounds: number,
  scrambledWord: string,
  hint: string,
  secondsRemaining: number = 30
): string {
  const formattedWord = formatScrambledWord(scrambledWord);

  return (
    `HOODIE'S CIPHER • ROUND ${round}/${totalRounds}\n\n` +
    `❓ Scramble: ${formattedWord}\n` +
    `💡 Hint: ${hint}\n\n` +
    `⚡ Reward: Top 3 (+50 / +25 / +10 Pts) | ⏳ ${secondsRemaining}s`
  );
}

export function buildScramblePodiumMessage(
  round: number,
  totalRounds: number,
  correctWord: string,
  winners: ScrambleWinner[]
): string {
  let outcomeText = '';

  if (winners.length === 0) {
    outcomeText = `❌ Time's up! Nobody answered correctly.`;
  } else {
    outcomeText = `🏆 WINNERS:\n`;
    winners.forEach((w, index) => {
      const medals = ['🥇', '🥈', '🥉'];
      const medal = medals[index] || '🏅';
      const handle = w.username ? `@${w.username}` : `User ${w.userId}`;
      outcomeText += `${medal} ${handle} (+${w.pointsAwarded} Pts) — ${w.timeTakenSec.toFixed(1)}s\n`;
    });
  }

  return (
    `HOODIE'S CIPHER • ROUND ${round}/${totalRounds} CONCLUDED\n\n` +
    `❓ Scramble: ${correctWord.toUpperCase()}\n` +
    `✅ Answer: ${correctWord.toUpperCase()}\n\n` +
    `${outcomeText}`
  );
}

export async function handleScrambleGuess(
  telegram: Telegram,
  session: ActiveScrambleSession,
  userId: number,
  username: string,
  userGuess: string,
  updateUserPointsFn: (userId: number, pts: number) => Promise<void>
): Promise<boolean> {
  if (userGuess.trim().toUpperCase() !== session.word.toUpperCase()) {
    return false;
  }

  if (session.winners.some((w) => w.userId === userId)) {
    return false;
  }

  const rankIndex = session.winners.length;
  if (rankIndex >= 3) {
    return false;
  }

  const reward = SCRAMBLE_REWARDS[rankIndex];
  const timeTakenSec = (Date.now() - session.startTime) / 1000;

  session.winners.push({
    userId,
    username,
    pointsAwarded: reward.points,
    timeTakenSec,
  });

  await updateUserPointsFn(userId, reward.points);

  if (session.winners.length === 1) {
    session.graceTimer = setTimeout(() => {
      finalizeScrambleRound(telegram, session);
    }, 7000);
  } else if (session.winners.length === 3) {
    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (session.roundTimer) clearTimeout(session.roundTimer);
    finalizeScrambleRound(telegram, session);
  }

  return true;
}

export async function finalizeScrambleRound(
  telegram: Telegram,
  session: ActiveScrambleSession
) {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  if (session.roundTimer) clearTimeout(session.roundTimer);

  const podiumContent = buildScramblePodiumMessage(
    session.currentRound,
    session.totalRounds,
    session.word,
    session.winners
  );

  try {
    await telegram.editMessageText(
      session.chatId,
      session.messageId,
      undefined,
      podiumContent,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Failed to edit scramble message:', error);
  }
}
