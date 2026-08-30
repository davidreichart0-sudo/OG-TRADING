# Setup Guide

## 0. Prerequisites

- Node.js 20+
- Docker + Docker Compose
- A **new, dedicated** Solana wallet for the bot (never your main wallet)

Everything below runs at **$0** unless you deliberately add a paid API key. See the cost banner at the top of `.env.example` for exactly which variables are free-by-default, free-with-signup, or paid.

## 1. Install

```bash
git clone <this project>
cd solana-sniper-bot
npm install
cp .env.example .env
```

## 2. Find your FOMO_PROGRAM_ID (required — nothing works without this)

FOMO (fomopad / fomo.family) doesn't publish a single fixed program ID doc page the way some platforms do, so you need to find it yourself once:

1. Launch (or find) any one token on fomopad.net / fomo.family.
2. Open that token's creation transaction in [Solscan](https://solscan.io) or the [Solana Explorer](https://explorer.solana.com).
3. Look at the instruction that creates the mint / bonding curve — the **Program** column shows the program ID that owns it.
4. Copy that address into `FOMO_PROGRAM_ID` in `.env`.

Until this is set, `src/core/listener.ts` has nothing to subscribe to and will log an error on startup instead of silently doing nothing.

> The listener's new-token detection (`src/core/listener.ts`) and pool discovery (`src/core/tokenAnalyzer.ts::derivePoolAddress`) use generic, best-effort heuristics (watching for `InitializeMint`, then looking for an account owned by your program ID) rather than FOMO's exact instruction layout, because that layout isn't publicly documented in a stable way. If you get FOMO's IDL (ask in their Discord/Telegram, or decode it from an on-chain transaction with a tool like [Anchor's IDL fetch](https://www.anchor-lang.com/)), swap these heuristics for exact instruction parsing — it will be both faster and more reliable.

## 3. Start the database + cache

```bash
docker compose up -d postgres redis
npm run prisma:migrate
```

## 4. Run in paper trading mode (the default — no funds move)

```bash
npm run dev
```

Open `http://localhost:3000` for the dashboard. Leave `LIVE_TRADING=false` in `.env` for as long as you want — paper mode is not a "trial", it's a fully separate, permanent mode you can run indefinitely.

## 5. (Optional, still free) Add Telegram alerts

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → get a token.
2. Put it in `TELEGRAM_BOT_TOKEN`.
3. Add the bot to a chat/channel you control, send it one message, then find that chat's ID (e.g. via `https://api.telegram.org/bot<token>/getUpdates`) and put it in `TELEGRAM_ALERT_CHAT_ID`.

## 6. (Optional, free with signup) Add Jupiter + Helius keys

- Jupiter: sign up at [developers.jup.ag/portal](https://developers.jup.ag/portal), grab a key on the free **Lite** plan (25M credits/month, $0), put it in `JUPITER_API_KEY`. Needed for swap execution — without it, live/paper swap quotes will hit tight anonymous rate limits.
- Helius (optional): free plan, 1M credits/month, put it in `HELIUS_API_KEY` for faster smart-money wallet lookups. Without it, the bot falls back to slower raw-RPC parsing — still free, still works.

## 7. Connect the MCP server to Claude Desktop

The MCP server (`src/mcp/server.ts`) is read-only + safe-config-only — see the comment at the top of that file for why it deliberately can't flip on live trading or place trades itself.

Edit your Claude Desktop config:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fomo-sniper-bot": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/solana-sniper-bot/src/mcp/server.ts"],
      "env": {
        "DATABASE_URL": "postgresql://sniper:sniper@localhost:5432/sniper_bot?schema=public",
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

Restart Claude Desktop. You can then ask things like "show my open sniper bot positions" or "raise the minimum social score to 40".

## 8. Going live — checklist

Live trading requires **both** `LIVE_TRADING=true` **and** `I_UNDERSTAND_THE_RISK=true` in `.env` (either alone does nothing — this is deliberate, see `src/config/index.ts`). Before you set both:

- [ ] You've run paper trading long enough to be comfortable with how it behaves
- [ ] `WALLET_PRIVATE_KEY` is a **dedicated burner wallet**, not your main wallet
- [ ] That wallet is funded with only what you're fully prepared to lose
- [ ] `MAX_POSITION_SOL` and `MAX_DAILY_LOSS_SOL` are set to numbers you're genuinely fine losing
- [ ] You understand that passing every automated check in this bot does **not** mean a token can't rug — see the disclaimer in the README

## 9. Deployment

`docker compose up -d --build` runs Postgres, Redis, and the bot together. The dashboard/API is exposed on port 3000 (`API_PORT`). The MCP server is meant to run locally next to your Claude Desktop install (stdio transport), not inside this Docker stack — it only needs read access to the same Postgres database, which works fine from your host machine if you expose the `postgres` port (already done in `docker-compose.yml`).
