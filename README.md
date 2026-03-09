# Solana Agent Wallet

Autonomous Solana trading agent with encrypted wallet management, AI-driven decision-making via **Groq (GroqCloud)**, and a full-screen terminal UI. Creates wallets programmatically, signs transactions automatically, holds SOL/SPL tokens, and trades on Jupiter DEX — all without human intervention.

## Features

- **Encrypted Wallets** — AES-256-GCM with PBKDF2 key derivation (100k iterations)
- **Autonomous Trading** — AI-powered decisions via Groq API (GroqCloud)
- **Jupiter DEX** — Best-price swaps across 20+ Solana DEXs
- **Full-Screen TUI** — Alt-screen terminal UI with live scrolling, busy indicators, and slash commands
- **Multi-Agent** — Run multiple agents simultaneously, each with its own wallet
- **Dry-Run Mode** — Test strategies without risking funds (default)
- **Built-in Strategies** — Conservative, momentum, DCA
- **Devnet Ready** — Works out of the box on Solana devnet

## Prerequisites

- **Node.js 18+**
- **Groq API key** — Get one at [console.groq.com](https://console.groq.com)
- **Solana devnet SOL** — Free via `solana-agent wallet fund <name>` or [faucet.solana.com](https://faucet.solana.com)

## Install

```bash
git clone <this-repo>
cd solana-agent-wallet
npm install
npm run build
npm link          # Makes `solana-agent` available globally
```

## Quick Start

```bash
# 1. Set your Groq API key (config field is "grokApiKey" for backward compat)
solana-agent config set grokApiKey gsk_...

# 2. Create a wallet
solana-agent wallet create alice

# 3. Fund with devnet SOL
solana-agent wallet fund alice

# 4. Start the agent (dry-run by default — launches full-screen TUI)
solana-agent run alice -s conservative

# 5. Inside TUI: use slash commands
#    /status    — show running agents
#    /balance   — check current balances
#    /strategy  — show current strategy
#    /stop      — stop the agent loop
#    /quit      — exit TUI
#    Ctrl+C     — graceful shutdown
```

## Commands

### Wallet Management
```
solana-agent wallet create <name>     Create encrypted agent wallet
solana-agent wallet list              List all wallets
solana-agent wallet fund <name>       Airdrop devnet SOL
solana-agent wallet balance <name>    Check SOL + SPL balances
solana-agent wallet export <name>     Export keypair (danger — requires confirmation)
```

### Agent Control
```
solana-agent run <name> [-s strategy] [--live]   Start autonomous AI agent (TUI)
solana-agent status                               Show running agents
solana-agent stop <name>                          Stop an agent
```

### Configuration
```
solana-agent config set <key> <value>   Set config value
solana-agent config show                Show current config (keys masked)
```

## Trading Strategies

| Strategy       | Max Trade | Min Confidence | Interval | Description |
|---------------|-----------|----------------|----------|-------------|
| `conservative` | 10%       | 80%            | 60s      | Capital preservation, blue-chips only |
| `momentum`     | 25%       | 60%            | 30s      | Follow trends, moderate risk |
| `dca`          | 5%        | 30%            | 120s     | Dollar cost averaging |

## Config Keys

| Key             | Env Var          | Description                    | Default |
|-----------------|------------------|--------------------------------|---------|
| `grokApiKey`    | `GROK_API_KEY`   | Groq API key (required) *      | — |
| `grokModel`     | `GROK_MODEL`     | Groq model to use *            | `llama-3.3-70b-versatile` |
| `solanaRpcUrl`  | `SOLANA_RPC_URL`  | Solana RPC endpoint           | `https://api.devnet.solana.com` |
| `solanaNetwork` | `SOLANA_NETWORK`  | `devnet` or `mainnet`         | `devnet` |
| `jupiterApiKey` | `JUPITER_API_KEY` | Jupiter API key (mainnet)     | — |

> **\* Naming note:** The config fields and env vars say "grok" for backward compatibility with the existing codebase, but the actual AI backend is **Groq (GroqCloud)** at `https://api.groq.com/openai/v1`. Keys start with `gsk_`.

## How It Works

Each agent runs an autonomous loop inside a full-screen terminal UI:

1. **Query balances** — SOL + all tracked SPL tokens via Solana RPC
2. **AI analysis** — Send portfolio data to Groq with strategy-specific system prompt
3. **Decision** — AI returns JSON: `{action, fromToken, toToken, amountPercent, confidence, reasoning}`
4. **Execute** — If confidence meets threshold, swap via Jupiter DEX (quote → build tx → sign → submit)
5. **Log & repeat** — File logging with key sanitization, then sleep until next cycle

The TUI shows all decisions, trades, errors, and status in real-time with color-coded log entries, animated busy indicators while waiting for AI responses, and a command bar for interactive control.

## Architecture

```
src/
  index.ts      CLI entry point (Commander.js)
  ui.ts         Full-screen TUI (TerminalUI class) + standalone helpers
  agent.ts      Multi-agent orchestrator (start/stop/status)
  strategy.ts   Trading strategies + AI decision prompt engineering
  compute.ts    Groq API client (OpenAI-compatible)
  wallet.ts     AES-256-GCM encrypted wallet management
  solana.ts     Solana RPC, balances, token registry
  jupiter.ts    Jupiter DEX quotes + swap execution
  logger.ts     File logger with key sanitization
  types.ts      TypeScript interfaces

~/.solana-agent/
  config.json           Global configuration
  wallets/
    alice.json          AES-256-GCM encrypted keypair
  logs/
    alice-2025-01-15.log  Sanitized agent logs
```

## Security

- **Encryption**: AES-256-GCM with 32-byte random salt, 16-byte IV, PBKDF2 100k iterations
- **Password at runtime**: Never stored on disk — required each time you unlock a wallet
- **Key sanitization**: Private keys automatically redacted in all log files
- **Dry-run default**: Real trades only execute with explicit `--live` flag + confirmation prompt
- **No key in config**: API keys stored in `~/.solana-agent/config.json` (user-only readable) or env vars

See [DEEP_DIVE.md](DEEP_DIVE.md) for a comprehensive security analysis.

## Supported Tokens

SOL, USDC, USDT, BONK, JUP, RAY, ORCA, PYTH — registered in the built-in token registry with correct mints and decimals.

## License

MIT
