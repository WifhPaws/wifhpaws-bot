import { Telegram } from 'telegraf';

export interface TriviaWinner {
  userId: number;
  username: string;
  pointsAwarded: number;
  timeTakenSec: number;
}

export interface ActiveTriviaSession {
  chatId: number;
  messageId: number;
  currentRound: number;
  totalRounds: number;
  question: string;
  answer: string;
  category?: string;
  startTime: number;
  winner?: TriviaWinner;
  roundTimer?: NodeJS.Timeout;
}

export const TRIVIA_REWARD_POINTS = 50;

export function buildTriviaCardMessage(
  round: number,
  totalRounds: number,
  question: string,
  category: string = 'Robinhood Chain & WIFH',
  secondsRemaining: number = 30
): string {
  return (
    `WIFH TRIVIA • QUESTION ${round}/${totalRounds}\n\n` +
    `❓ Question: ${question}\n` +
    `🏷️ Category: ${category}\n\n` +
    `⚡ Reward: +${TRIVIA_REWARD_POINTS} Pts | ⏳ ${secondsRemaining}s`
  );
}

export function buildTriviaResultMessage(
  round: number,
  totalRounds: number,
  question: string,
  correctAnswer: string,
  winner?: TriviaWinner
): string {
  let outcomeText = '';

  if (!winner) {
    outcomeText = `❌ Time's up! Nobody answered correctly.`;
  } else {
    const handle = winner.username ? `@${winner.username}` : `User ${winner.userId}`;
    outcomeText = (
      `🏆 FIRST TO ANSWER:\n` +
      `🥇 ${handle} (+${winner.pointsAwarded} Pts) — ${winner.timeTakenSec.toFixed(1)}s`
    );
  }

  return (
    `WIFH TRIVIA • QUESTION ${round}/${totalRounds} CONCLUDED\n\n` +
    `❓ Question: ${question}\n` +
    `✅ Answer: ${correctAnswer.toUpperCase()}\n\n` +
    `${outcomeText}`
  );
}

export async function handleTriviaGuess(
  telegram: Telegram,
  session: ActiveTriviaSession,
  userId: number,
  username: string,
  userGuess: string,
  updateUserPointsFn: (userId: number, pts: number) => Promise<void>
): Promise<boolean> {
  if (session.winner) return false;

  if (userGuess.trim().toUpperCase() !== session.answer.toUpperCase()) {
    return false;
  }

  const timeTakenSec = (Date.now() - session.startTime) / 1000;

  session.winner = {
    userId,
    username,
    pointsAwarded: TRIVIA_REWARD_POINTS,
    timeTakenSec,
  };

  await updateUserPointsFn(userId, TRIVIA_REWARD_POINTS);

  if (session.roundTimer) clearTimeout(session.roundTimer);
  await finalizeTriviaRound(telegram, session);

  return true;
}

export async function finalizeTriviaRound(
  telegram: Telegram,
  session: ActiveTriviaSession
) {
  if (session.roundTimer) clearTimeout(session.roundTimer);

  const resultContent = buildTriviaResultMessage(
    session.currentRound,
    session.totalRounds,
    session.question,
    session.answer,
    session.winner
  );

  try {
    await telegram.editMessageText(
      session.chatId,
      session.messageId,
      undefined,
      resultContent,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Failed to edit trivia message:', error);
  }
}
