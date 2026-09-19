import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// ==============================================================================
// 🐾 WifhPaws Bot Customizable Settings
// Modify these values below to adjust bot behavior without editing core logic.
// ==============================================================================

/** List of keywords/phrases in group chats that award points (case-insensitive) */
export const TRIGGER_KEYWORDS: string[] = [
  "thank you",
  "thanks",
  "ty",
  "gm",
  "lfg",
];

/** Number of Paw Points awarded per triggered keyword */
export const POINTS_PER_TRIGGER: number = 10;

/** Cooldown period in minutes per user to prevent spam */
export const COOLDOWN_MINUTES: number = 60;

/**
 * Message template sent when points are awarded.
 * Placeholders:
 *   - @username or {username}: Replaced by user's Telegram @handle or display name
 *   - {points}: Replaced by points awarded
 */
export const REWARD_MESSAGE: string =
  "🐾 Woof! @username just earned {points} Paw Points! Keep spreading good vibes!";

// ==============================================================================
// Environment Variables & Validation
// ==============================================================================

export interface AppConfig {
  botToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  adminUserIds: number[];
}

function parseAdminUserIds(raw?: string): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

export function loadConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN?.trim() || "";
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim() || "";
  const adminUserIds = parseAdminUserIds(process.env.ADMIN_USER_IDS);

  return {
    botToken,
    supabaseUrl,
    supabaseAnonKey,
    adminUserIds,
  };
}

/**
 * Formats the reward message replacing placeholders safely.
 */
export function formatRewardMessage(usernameOrName: string, points: number): string {
  // If username starts with @ or is a display name, format cleanly
  const formattedName = usernameOrName.startsWith("@")
    ? usernameOrName
    : `@${usernameOrName}`;

  return REWARD_MESSAGE
    .replace(/@username\b/gi, formattedName)
    .replace(/\{username\}/gi, formattedName)
    .replace(/\{points\}/gi, points.toString());
}
