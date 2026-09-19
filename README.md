# WifhPaws Telegram Bot 🐾

A high-performance community Telegram bot built with **TypeScript**, **Node.js**, **Telegraf**, and **Supabase**. 

Reward positive vibes in your crypto community with **Paw Points**!

---

## ✨ Features

- 🐾 **Group Keyword Listener**: Listens to messages in group chats and rewards users when they say positive words (`gm`, `thanks`, `ty`, `lfg`, etc.).
- ⏱️ **Cooldown Management**: Persistent cooldown per user (e.g. 60 minutes) stored directly in Supabase to prevent spam.
- 🏆 **/leaderboard**: Shows the top 10 community members with medals (🥇, 🥈, 🥉, 🐾).
- 🎁 **/airdrop @handle <amount>**: Admin-only command to reward community members.
- 💎 **/mypoints**: Allows users to check their point balance.
- 🌐 **Render Ready**: Includes a lightweight built-in HTTP health check server for 24/7 hosting on Render's Free Web Service tier.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (v18+)
- **Language**: TypeScript
- **Telegram Framework**: Telegraf v4
- **Database**: Supabase (PostgreSQL)

---

## ⚙️ Environment Variables

Create a `.env` file or set these in your hosting environment (e.g. Render Dashboard):

| Variable | Description |
| :--- | :--- |
| `BOT_TOKEN` | Telegram Bot API token from [@BotFather](https://t.me/BotFather) |
| `SUPABASE_URL` | Your Supabase Project URL (`https://<project-ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Supabase Anon/Public API Key |
| `ADMIN_USER_IDS` | Comma-separated list of numeric Telegram User IDs authorized for `/airdrop` |
| `PORT` | *(Optional)* HTTP Port for health check (default: `3000` or assigned by Render) |

---

## 🚀 Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure .env
cp .env.example .env
# Edit .env with your credentials

# 3. Build & Run
npm run build
npm start
```

---

## ☁️ Deployment on Render

1. Create a new **Web Service** on [Render](https://render.com).
2. Connect your GitHub repository.
3. Configure the service:
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. In **Environment Variables**, add:
   - `BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `ADMIN_USER_IDS`
5. Click **Create Web Service**!
