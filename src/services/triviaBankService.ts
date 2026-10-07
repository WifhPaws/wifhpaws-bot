import fs from 'fs';
import path from 'path';

export interface CuratedTriviaQuestion {
  id?: string;
  question: string;
  answer?: string;
  options?: string[];
  correct?: number;
}

export interface TriviaBank {
  crypto_wifh: CuratedTriviaQuestion[];
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
 * Helper to ensure a question has 4 randomized multiple-choice options.
 * If options/correct already exist, they are preserved.
 * If only question and answer exist, 3 distinct distractors from the category answer pool are selected.
 */
function resolveQuestionOptions(
  q: CuratedTriviaQuestion,
  allAnswers: string[]
): { question: string; options: string[]; correctOptionId: number } {
  if (q.options && q.options.length >= 2 && typeof q.correct === 'number') {
    return {
      question: q.question,
      options: q.options,
      correctOptionId: q.correct,
    };
  }

  const correctAnswer = q.answer || (q.options ? q.options[0] : 'Correct');
  const otherAnswers = allAnswers.filter(a => a.toLowerCase() !== correctAnswer.toLowerCase());
  const shuffledOthers = [...otherAnswers].sort(() => 0.5 - Math.random());
  const distractors = shuffledOthers.slice(0, 3);

  while (distractors.length < 3) {
    distractors.push(`Alternative ${distractors.length + 1}`);
  }

  const options = [...distractors, correctAnswer].sort(() => 0.5 - Math.random());
  const correctOptionId = options.indexOf(correctAnswer);

  return {
    question: q.question,
    options,
    correctOptionId: Math.max(0, correctOptionId),
  };
}

/**
 * Fetch a random question from the loaded trivia bank given a specific category.
 * Returns null if the category does not exist or has no questions.
 */
export function getRandomQuestionByCategory(category: keyof TriviaBank): { id: string; question: string; options: string[]; correct: number } | null {
  const bank = getTriviaBank();
  const questions = bank[category];

  if (!questions || questions.length === 0) {
    return null;
  }

  const allAnswers = Array.from(
    new Set(
      questions
        .map(q => q.answer || (q.options && typeof q.correct === 'number' ? q.options[q.correct] : null))
        .filter((a): a is string => Boolean(a && a.trim()))
    )
  );

  const randomIndex = Math.floor(Math.random() * questions.length);
  const rawQ = questions[randomIndex];
  const resolved = resolveQuestionOptions(rawQ, allAnswers);

  return {
    id: rawQ.id || `q_${randomIndex + 1}`,
    question: resolved.question,
    options: resolved.options,
    correct: resolved.correctOptionId,
  };
}

/**
 * Fetch a batch of questions from the bank for a specific category,
 * up to the requested count. Questions are shuffled to avoid repetition.
 */
export function getTriviaQuestionsByCategory(
  category: keyof TriviaBank,
  count: number = 10
): Array<{ question: string; options: string[]; correctOptionId: number }> {
  const bank = getTriviaBank();
  const questions = bank[category] || [];

  if (!questions || questions.length === 0) {
    return [];
  }

  const allAnswers = Array.from(
    new Set(
      questions
        .map(q => q.answer || (q.options && typeof q.correct === 'number' ? q.options[q.correct] : null))
        .filter((a): a is string => Boolean(a && a.trim()))
    )
  );

  const shuffled = [...questions].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count).map(q => resolveQuestionOptions(q, allAnswers));
}

export type TriviaCategory = keyof TriviaBank;

const CONFIG_PATH = path.resolve(process.cwd(), 'trivia-config.json');
let activeCategoryCache: TriviaCategory = 'crypto_wifh';

/**
 * Get the currently active category for live trivia games.
 */
export function getActiveTriviaCategory(): TriviaCategory {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (data.activeCategory === 'crypto_wifh' || data.activeCategory === 'general_knowledge') {
        activeCategoryCache = data.activeCategory;
      }
    }
  } catch (err) {
    // Ignore and fallback to cache
  }
  return activeCategoryCache;
}

/**
 * Set the currently active category for live trivia games.
 */
export function setActiveTriviaCategory(category: TriviaCategory): void {
  activeCategoryCache = category;
  try {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ activeCategory: category }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    console.warn('[triviaBankService] Failed to write trivia-config.json:', err);
  }
}
