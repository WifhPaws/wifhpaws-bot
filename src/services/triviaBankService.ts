import fs from 'fs';
import path from 'path';

export interface CuratedTriviaQuestion {
  id: string;
  question: string;
  options: string[];
  correct: number;
}

export interface TriviaBank {
  crypto_wifh: CuratedTriviaQuestion[];
  general_crypto: CuratedTriviaQuestion[];
  general_knowledge: CuratedTriviaQuestion[];
}

const TRIVIA_BANK_PATH = path.resolve(process.cwd(), 'trivia-bank.json');

let triviaBankCache: TriviaBank | null = null;

/**
 * Safely reads and parses the trivia-bank.json file from the root directory.
 * Caches the result in memory after the first read.
 */
export function getTriviaBank(): TriviaBank {
  if (triviaBankCache) {
    return triviaBankCache;
  }

  try {
    const rawData = fs.readFileSync(TRIVIA_BANK_PATH, 'utf-8');
    triviaBankCache = JSON.parse(rawData) as TriviaBank;
    return triviaBankCache;
  } catch (error) {
    console.error('[triviaBankService] Error reading or parsing trivia-bank.json:', error);
    // Return an empty shell as a safe fallback
    return {
      crypto_wifh: [],
      general_crypto: [],
      general_knowledge: []
    };
  }
}

/**
 * Force a reload of the trivia bank file from disk.
 */
export function reloadTriviaBank(): void {
  triviaBankCache = null;
  getTriviaBank();
}

/**
 * Fetch a random question from the loaded trivia bank given a specific category.
 * Returns null if the category does not exist or has no questions.
 */
export function getRandomQuestionByCategory(category: keyof TriviaBank): CuratedTriviaQuestion | null {
  const bank = getTriviaBank();
  const questions = bank[category];

  if (!questions || questions.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * questions.length);
  return questions[randomIndex];
}
