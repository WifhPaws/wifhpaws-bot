import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config";

export interface BotUser {
  telegram_id: number;
  username: string | null;
  points: number;
  wallet_address: string | null;
  last_awarded_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AwardResult {
  awarded: boolean;
  reason?: "cooldown" | "error";
  minutesLeft?: number;
  newPoints?: number;
}

export interface AirdropResult {
  success: boolean;
  user?: BotUser;
  amount?: number;
  error?: string;
}

let supabaseInstance: SupabaseClient | null = null;

/**
 * Initializes and returns the singleton Supabase client.
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseInstance) {
    const config = loadConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error(
        "Supabase credentials missing. Please set SUPABASE_URL and SUPABASE_ANON_KEY in your .env file."
      );
    }
    supabaseInstance = createClient(config.supabaseUrl, config.supabaseAnonKey);
  }
  return supabaseInstance;
}

/**
 * Fetches or creates a user record in the Supabase 'users' table.
 */
export async function getOrCreateUser(
  telegramId: number,
  username: string | null
): Promise<BotUser | null> {
  const supabase = getSupabase();

  const { data: existingUser, error: fetchError } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();

  if (fetchError && fetchError.code !== "PGRST116") {
    // PGRST116 is "Row not found"
    console.error(`[Supabase] Error fetching user ${telegramId}:`, fetchError.message);
    return null;
  }

  if (existingUser) {
    // Update username if it changed
    if (username && existingUser.username !== username) {
      const { data: updatedUser } = await supabase
        .from("users")
        .update({ username, updated_at: new Date().toISOString() })
        .eq("telegram_id", telegramId)
        .select()
        .single();
      return updatedUser || existingUser;
    }
    return existingUser;
  }

  // Insert new user
  const { data: newUser, error: insertError } = await supabase
    .from("users")
    .insert([
      {
        telegram_id: telegramId,
        username: username,
        points: 0,
        last_awarded_at: null,
      },
    ])
    .select()
    .single();

  if (insertError) {
    console.error(`[Supabase] Error creating user ${telegramId}:`, insertError.message);
    return null;
  }

  return newUser;
}

/**
 * Checks cooldown and awards keyword trigger points to a user.
 */
export async function awardKeywordPoints(
  telegramId: number,
  username: string | null,
  pointsToAward: number,
  cooldownMinutes: number
): Promise<AwardResult> {
  const supabase = getSupabase();
  const now = new Date();

  // 1. Get or create user
  const user = await getOrCreateUser(telegramId, username);
  if (!user) {
    return { awarded: false, reason: "error" };
  }

  // 2. Check Cooldown
  if (user.last_awarded_at) {
    const lastAwardedTime = new Date(user.last_awarded_at).getTime();
    const elapsedMinutes = (now.getTime() - lastAwardedTime) / (1000 * 60);

    if (elapsedMinutes < cooldownMinutes) {
      const minutesLeft = Math.ceil(cooldownMinutes - elapsedMinutes);
      return {
        awarded: false,
        reason: "cooldown",
        minutesLeft,
      };
    }
  }

  // 3. Award points & update last_awarded_at
  const newPoints = (user.points || 0) + pointsToAward;
  const isoNow = now.toISOString();

  const { error: updateError } = await supabase
    .from("users")
    .update({
      points: newPoints,
      last_awarded_at: isoNow,
      updated_at: isoNow,
      ...(username ? { username } : {}),
    })
    .eq("telegram_id", telegramId);

  if (updateError) {
    console.error(`[Supabase] Failed to update points for ${telegramId}:`, updateError.message);
    return { awarded: false, reason: "error" };
  }

  return {
    awarded: true,
    newPoints,
  };
}

/**
 * Retrieves the top users ordered by points for /leaderboard.
 */
export async function getLeaderboard(limit = 10): Promise<BotUser[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("users")
    .select("telegram_id, username, points, wallet_address, last_awarded_at")
    .order("points", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[Supabase] Failed to fetch leaderboard:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Resolves a Telegram @handle in Supabase and awards airdropped points.
 */
export async function airdropPointsByHandle(
  rawHandle: string,
  amount: number
): Promise<AirdropResult> {
  const supabase = getSupabase();
  const cleanHandle = rawHandle.replace(/^@/, "").trim();

  if (!cleanHandle) {
    return { success: false, error: "Invalid username handle provided." };
  }

  // Find user by case-insensitive username
  const { data: user, error: findError } = await supabase
    .from("users")
    .select("*")
    .ilike("username", cleanHandle)
    .single();

  if (findError || !user) {
    return {
      success: false,
      error: `User @${cleanHandle} was not found in the database. They must first send a message or trigger points in the chat.`,
    };
  }

  const updatedPoints = (user.points || 0) + amount;
  const { data: updatedUser, error: updateError } = await supabase
    .from("users")
    .update({
      points: updatedPoints,
      updated_at: new Date().toISOString(),
    })
    .eq("telegram_id", user.telegram_id)
    .select()
    .single();

  if (updateError || !updatedUser) {
    return {
      success: false,
      error: `Failed to update points: ${updateError?.message || "Unknown error"}`,
    };
  }

  return {
    success: true,
    user: updatedUser,
    amount,
  };
}
