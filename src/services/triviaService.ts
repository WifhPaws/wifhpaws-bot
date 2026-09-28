import fetch from 'node-fetch';
import { decodeHtml } from '../utils/decodeHtml';
import { shuffle } from '../utils/shuffle';

export interface TriviaQuestion {
  question: string;
  options: string[];
  correctOptionId: number;
}

/** Fetch 10 multiple‑choice trivia questions from Open Trivia DB */
export const fetchTriviaBatch = async (): Promise<TriviaQuestion[]> => {
  const categories = [27, 28, 11, 12, 14];
  const selectedCategory = categories[Math.floor(Math.random() * categories.length)];
  const response = await fetch(
    `https://opentdb.com/api.php?amount=10&category=${selectedCategory}&difficulty=easy&type=multiple`
  );
  if (!response.ok) {
    throw new Error(`Trivia API request failed: ${response.status}`);
  }
  const data: any = await response.json();
  if (data.response_code !== 0) {
    throw new Error('Trivia API returned a non‑zero response code');
  }

  return data.results.map((raw: any): TriviaQuestion => {
    const question = decodeHtml(raw.question);
    const correct = decodeHtml(raw.correct_answer);
    const incorrect = raw.incorrect_answers.map((a: string) => decodeHtml(a));
    const shuffled = shuffle([correct, ...incorrect]);
    const correctIdx = shuffled.findIndex(opt => opt === correct);
    return { question, options: shuffled, correctOptionId: correctIdx };
  });
};
