# Commands Report

## Overview
The bot defines a large set of commands across **src/index.ts** and **src/bot.ts**. Below is a consolidated list of all commands detected by a grep search:

| File | Command | Description (in‑code comment) |
|------|---------|-------------------------------|
| `src/bot.ts` | `start` / `help` | Welcome message and help text for users. |
| `src/bot.ts` | `mypoints` / `points` / `me` | Show the calling user’s Paw Points. |
| `src/bot.ts` | `leaderboard` | Show top 10 Paw Point holders. |
| `src/bot.ts` | `airdrop` | Admin‑only airdrop of points to a Telegram handle. |
| `src/index.ts` | `start` | Handles `/start` with optional arguments (`wallet`, `send`). Provides group‑chat welcome or private‑chat admin panel / wallet dashboard. |
| `src/index.ts` | `wallet` | Shows the user’s wallet dashboard in private chat; in groups it replies with a button that opens a private conversation (`https://t.me/<bot>?start=wallet`). |
| `src/index.ts` | `send` | Transfer funds (private chat only). |
| `src/index.ts` | `tsend` | Treasury‑send (admin only). |
| `src/index.ts` | `swap` | Swap tokens (admin only). |
| `src/index.ts` | `buy` | Buy WIFH with ETH (admin only). |
| `src/index.ts` | `sell` | Sell WIFH for ETH (admin only). |
| `src/index.ts` | `tswap` | Treasury swap (admin only). |
| `src/index.ts` | `tbuy` | Treasury buy (admin only). |
| `src/index.ts` | `tsell` | Treasury sell (admin only). |
| `src/index.ts` | `adminhelp` | Show admin help cheat sheet. |
| `src/index.ts` | `migrate_wallets` | Migrate legacy wallets (admin only). |
| `src/index.ts` | `makeadmin` | Promote a user to admin. |
| `src/index.ts` | `admin` | Open the admin control center. |
| `src/index.ts` | `treasury` | Show treasury dashboard. |
| `src/index.ts` | `airdrop` | Admin airdrop (duplicate of the one in `bot.ts`). |
| `src/index.ts` | `leaderboard` | Show leaderboard (duplicate of the one in `bot.ts`). |
| `src/index.ts` | `addpoints` | Admin add points to a user. |
| `src/index.ts` | `resetpoints` | Admin reset points for a user. |
| `src/index.ts` | `resetallpoints` | Admin reset all points. |
| `src/index.ts` | `addkeyword` | Add a keyword reward. |
| `src/index.ts` | `removekeyword` | Remove a keyword reward. |
| `src/index.ts` | `clearallkeywords` | Delete all keywords. |
| `src/index.ts` | `keywords` | List all active keywords. |
| `src/index.ts` | `addtrigger` | Add a chat trigger. |
| `src/index.ts` | `removetrigger` | Remove a chat trigger. |
| `src/index.ts` | `listtriggers` | List all chat triggers. |
| `src/index.ts` | `cleartriggers` | Delete all chat triggers. |
| `src/middleware/vipBouncer.ts` | `starttrivia` (commented) | Intended admin‑only trivia starter – not currently active. |

## Issues Observed
1. **/start and /wallet commands not responding in group chats**
   - The handlers are present, but Telegram bots by default have *Privacy Mode* enabled. When enabled, the bot only receives messages that start with a command (which is the case) **and** it will not receive messages that are not directed specifically at it. However, some group settings still prevent the bot from receiving the command payload, especially if the command is sent without mentioning the bot (e.g., `/start` instead of `/start@WifhPawsBot`). This can make the command appear to do nothing.
2. **Duplicate command definitions**
   - `airdrop` and `leaderboard` are defined both in `src/bot.ts` *and* `src/index.ts`. While Telegraf will keep the last registration, having duplicates can cause confusion and makes future maintenance harder.
3. **Missing explicit command registration for `/help`**
   - `/help` is only handled as an alias of `/start` in `src/bot.ts`. If a user types `/help` in a group, the same privacy‑mode issues apply.
4. **Potential conflict with the admin panel creation**
   - The admin panel (`action_open_admin`) builds `adminKeyboard` without the newly added **Trivia Settings** button; however, the button exists in the definition but the handler is still missing (see previous work). This does not affect `/start`/`/wallet` directly but is a related UI inconsistency.

## Recommendations
### 1. Disable Bot Privacy Mode
   1. Open a chat with **@BotFather**.
   2. Send `/mybots` → select your bot.
   3. Choose **Bot Settings → Group Privacy**.
   4. Select **Turn off**.
   This allows the bot to receive all messages (including commands) in groups without requiring the `@BotName` mention.

### 2. Consolidate Duplicate Commands
   - Remove the duplicate `airdrop` and `leaderboard` definitions from either `src/bot.ts` **or** `src/index.ts`. Keeping a single source of truth reduces maintenance overhead.
   - Example: keep the robust implementations in `src/index.ts` (they already include admin checks) and delete the earlier versions in `src/bot.ts`.

### 3. Register `/help` Explicitly (optional)
   ```ts
   bot.command('help', async (ctx) => {
     // Re‑use the start/help logic
     return ctx.reply('Use /start to begin. ...');
   });
   ```
   This makes `/help` work even if the user forgets the alias.

### 4. Ensure `/start` Handles Group Chats Gracefully
   - The current `start` handler already sends a welcome message for group chats (lines 416‑426). After disabling privacy mode, it should fire correctly.
   - If you want the command to work when the bot is mentioned, you can add an alias:
   ```ts
   bot.command(['start', 'start@WifhPawsBot'], startHandler);
   ```
   (Replace `WifhPawsBot` with your actual bot username.)

### 5. Verify Bot Permissions in the Group
   - Ensure the bot is **added as a member** of the community chat.
   - Give it at least the *Read Messages* permission; admin rights are not required for basic command handling.

## Verification Plan
1. **Apply the above changes** (disable privacy mode, clean duplicates, optional code tweaks).
2. **Restart the bot** (`npm run build && npm start`).
3. In a group chat:
   - Send `/start` → you should receive the welcome message.
   - Send `/wallet` → the bot should reply with the private‑chat button.
4. In a private chat:
   - `/wallet` should immediately show the dashboard.
5. Check the bot logs for any “Command not found” warnings.

If any command still does not fire, the logs will pinpoint whether the update was received by the bot.
