import http from "http";
import { createBot } from "./bot";
import { loadConfig, TRIGGER_KEYWORDS, POINTS_PER_TRIGGER, COOLDOWN_MINUTES } from "./config";
import { getSupabase } from "./supabase";

async function main() {
  console.log("=========================================");
  console.log("🐾  WifhPaws Telegram Bot Starting...  🐾");
  console.log("=========================================");

  const config = loadConfig();

  // Validate required configuration
  if (!config.botToken) {
    console.error("❌ ERROR: BOT_TOKEN is required in your .env file.");
    process.exit(1);
  }

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    console.warn("⚠️  WARNING: SUPABASE_URL or SUPABASE_ANON_KEY is missing in your .env file.");
    console.warn("   Database features (points, leaderboard, airdrop) will fail until configured.");
  } else {
    // Ping Supabase to verify connection
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from("users").select("telegram_id").limit(1);
      if (error) {
        console.warn(`⚠️  Supabase connected but returned: ${error.message}`);
        console.warn("   Make sure you ran the migration from 'schema.sql' in your Supabase SQL editor!");
      } else {
        console.log("✅ Supabase connection verified successfully.");
      }
    } catch (err: any) {
      console.warn("⚠️  Could not connect to Supabase:", err.message);
    }
  }

  console.log(`📋 Configured Trigger Keywords: [${TRIGGER_KEYWORDS.join(", ")}]`);
  console.log(`💎 Points Per Trigger: ${POINTS_PER_TRIGGER}`);
  console.log(`⏱️  Cooldown Period: ${COOLDOWN_MINUTES} minutes`);
  console.log(`👑 Admin IDs: [${config.adminUserIds.join(", ") || "None specified"}]`);

  const bot = createBot();

  // Launch bot with long-polling
  bot.launch(() => {
    console.log("🚀 WifhPaws Bot is LIVE and listening for group events!");
  }).catch((err) => {
    console.error("❌ Failed to launch Telegram bot:", err.message);
    process.exit(1);
  });

  // Start a lightweight HTTP health check server for Render / hosting platforms
  const port = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", bot: "WifhPaws", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    console.log(`🌐 Health check server listening on port ${port}`);
  });

  // Graceful stop on termination signals
  const stopBot = (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Gracefully stopping WifhPaws bot...`);
    server.close();
    bot.stop(signal);
    process.exit(0);
  };

  process.once("SIGINT", () => stopBot("SIGINT"));
  process.once("SIGTERM", () => stopBot("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
