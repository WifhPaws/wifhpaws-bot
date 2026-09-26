import { supabase } from '../db/supabaseClient';

/**
 * Set the token payout amount for a given place (1, 2, or 3).
 */
export const setTriviaReward = async (place: number, amount: number) => {
  if (![1, 2, 3].includes(place)) {
    throw new Error('Place must be 1, 2, or 3');
  }
  const { error } = await supabase
    .from('trivia_rewards_config')
    .upsert({ place, amount }, { onConflict: 'place' });
  if (error) throw error;
};

/** Retrieve configured rewards for places 1‑3. Returns a map place→amount */
export const getTriviaRewards = async (): Promise<Record<number, number>> => {
  const { data, error } = await supabase
    .from('trivia_rewards_config')
    .select('place, amount');
  if (error) throw error;
  const map: Record<number, number> = {};
  data?.forEach((row: any) => {
    map[row.place] = Number(row.amount);
  });
  return map;
};
