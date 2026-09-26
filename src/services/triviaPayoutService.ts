// src/services/triviaPayoutService.ts
import { supabase } from '../db/supabaseClient';

export interface PayoutConfig {
  first: number;
  second: number;
  third: number;
}

/**
 * Store the three payout amounts (singleton row with id = 1).
 */
export const setPayoutConfig = async (
  first: number,
  second: number,
  third: number
): Promise<void> => {
  const { error } = await supabase
    .from('trivia_payouts')
    .upsert(
      { id: 1, first_amount: first, second_amount: second, third_amount: third },
      { onConflict: 'id' }
    );
  if (error) throw error;
};

/** Retrieve the current payout configuration. */
export const getPayoutConfig = async (): Promise<PayoutConfig> => {
  const { data, error } = await supabase
    .from('trivia_payouts')
    .select('first_amount, second_amount, third_amount')
    .eq('id', 1)
    .single();
  if (error) throw error;
  return {
    first: Number(data?.first_amount ?? 0),
    second: Number(data?.second_amount ?? 0),
    third: Number(data?.third_amount ?? 0),
  };
};

/** Placeholder airdrop implementation – logs intended transfers. */
export const airdropToWinners = async (
  winners: Array<{ place: number; wallet: string }>,
  cfg: PayoutConfig
): Promise<void> => {
  for (const w of winners) {
    const amount =
      w.place === 1 ? cfg.first : w.place === 2 ? cfg.second : cfg.third;
    if (amount > 0) {
      console.log(`[AIRDROP] ${amount} $WIFH → ${w.wallet} (place ${w.place})`);
      // TODO: replace with real treasury airdrop call
    }
  }
};
