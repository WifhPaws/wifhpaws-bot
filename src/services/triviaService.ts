import fetch from 'node-fetch';
import { decodeHtml } from '../utils/decodeHtml';
import { shuffle } from '../utils/shuffle';
import { supabase } from '../db/supabaseClient';

export interface TriviaQuestion {
  question: string;
  options: string[];
  correctOptionId: number;
}

/** All available Open Trivia DB category IDs */
const TRIVIA_CATEGORIES = [
  27, // Animals
  28, // Vehicles
  11, // Entertainment: Film
  12, // Entertainment: Music
  14, // Entertainment: Television
];

/**
 * Read the configured question_count from the trivia_payouts table.
 * Returns the stored value or 10 as a safe default.
 */
export async function getQuestionCount(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('trivia_payouts')
      .select('question_count')
      .limit(1)
      .maybeSingle();

    if (!error && data && typeof data.question_count === 'number' && data.question_count > 0) {
      return data.question_count;
    }
  } catch (err) {
    console.warn('[triviaService] Could not read question_count, using default:', err);
  }
  return 10;
}

/**
 * Update the question_count value in the trivia_payouts table.
 * Upserts a singleton row (id = 1) with the new count.
 */
export async function setQuestionCount(count: number): Promise<void> {
  const { error } = await supabase
    .from('trivia_payouts')
    .upsert({ id: 1, question_count: count }, { onConflict: 'id' });
  if (error) throw error;
}

/**
 * Fetch trivia questions spread evenly across all 5 categories,
 * then shuffle the combined set into a random mix.
 *
 * The total question count is read from the DB (defaults to 10).
 */
export const fetchTriviaBatch = async (): Promise<TriviaQuestion[]> => {
  const totalCount = await getQuestionCount();

  // Spread questions evenly across categories
  const perCategory = Math.max(1, Math.ceil(totalCount / TRIVIA_CATEGORIES.length));

  const allBatches: TriviaQuestion[][] = [];

  // Fetch sequentially with a 5-second delay to respect OpenTDB's strict rate limit
  for (let i = 0; i < TRIVIA_CATEGORIES.length; i++) {
    const categoryId = TRIVIA_CATEGORIES[i];
    try {
      if (i > 0) {
        // Wait 5000ms between requests to avoid HTTP 429 Too Many Requests
        await new Promise(res => setTimeout(res, 5000));
      }

      const response = await fetch(
        `https://opentdb.com/api.php?amount=${perCategory}&category=${categoryId}&difficulty=easy&type=multiple`
      );
      if (!response.ok) {
        console.warn(`[triviaService] Category ${categoryId} request failed: ${response.status}`);
        continue;
      }
      const data: any = await response.json();
      if (data.response_code !== 0) {
        console.warn(`[triviaService] Category ${categoryId} returned response_code ${data.response_code}`);
        continue;
      }
      const questions = data.results.map((raw: any): TriviaQuestion => {
        const question = decodeHtml(raw.question);
        const correct = decodeHtml(raw.correct_answer);
        const incorrect = raw.incorrect_answers.map((a: string) => decodeHtml(a));
        const shuffled = shuffle([correct, ...incorrect]);
        const correctIdx = shuffled.findIndex(opt => opt === correct);
        return { question, options: shuffled, correctOptionId: correctIdx };
      });
      allBatches.push(questions);
    } catch (err) {
      console.warn(`[triviaService] Failed to fetch category ${categoryId}:`, err);
    }
  }

  const combined = allBatches.flat();

  if (combined.length === 0) {
    throw new Error('Trivia API returned no questions from any category');
  }

  // Shuffle the combined pool, then trim to the exact requested count
  return shuffle(combined).slice(0, totalCount);
};
