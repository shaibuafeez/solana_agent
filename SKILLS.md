# Solana Agent Wallet — Agent Skill

## Skill: Autonomous Solana Trading Agent

### What It Does
Creates encrypted Solana wallets and runs autonomous AI trading agents powered by Groq (GroqCloud). Agents query on-chain market data, get AI-powered trading decisions, and execute swaps on Jupiter DEX — all without human intervention.

### Activation Triggers
- "Create a Solana trading bot"
- "Run an AI agent on Solana"
- "Autonomous crypto trading with AI"
- "Manage agent wallets on Solana"
- "AI-driven portfolio management"

### Architecture
```
┌─────────────────────────────────────────────────┐
│  Agent Loop (per wallet)                         │
│                                                  │
│  1. Query balances (SOL + SPL tokens via RPC)    │
│  2. Feed market data to Groq AI with strategy    │
│  3. AI returns: action/token/amount/confidence   │
│  4. Execute swap via Jupiter DEX (or dry-run)    │
│  5. Log result, update TUI, sleep, repeat        │
│                                                  │
│  Each agent has:                                 │
│    - Own encrypted wallet (AES-256-GCM)          │
│    - Own strategy + confidence threshold         │
│    - Own abort controller (independent stop)     │
│    - Own file logger (sanitized)                 │
└─────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| Wallet Manager | `wallet.ts` | Create, encrypt, decrypt, list keypairs |
| Agent Orchestrator | `agent.ts` | Start/stop/status, loop lifecycle |
| Strategy Engine | `strategy.ts` | Prompt engineering, decision parsing |
| AI Client | `compute.ts` | Groq API calls (OpenAI-compatible) |
| DEX Integration | `jupiter.ts` | Quote, build tx, sign, submit swaps |
| Balance Tracker | `solana.ts` | SOL + SPL token balances via RPC |
| Terminal UI | `ui.ts` | Full-screen TUI with live updates |
| Logger | `logger.ts` | File logging with key sanitization |

### AI Integration
- **Provider**: Groq (GroqCloud) via OpenAI-compatible API
- **Endpoint**: `https://api.groq.com/openai/v1/chat/completions`
- **Default model**: `llama-3.3-70b-versatile`
- **Auth**: Bearer token via `grokApiKey` config
- **Output format**: Structured JSON (action, tokens, amount, confidence, reasoning)
- **Strategy prompts**: Each strategy has a tailored system prompt that constrains AI behavior

### Trading Strategies
| Strategy     | Max Trade | Min Confidence | Interval | Risk Level |
|-------------|-----------|----------------|----------|------------|
| conservative | 10%       | 80%            | 60s      | Low |
| momentum     | 25%       | 60%            | 30s      | Medium |
| dca          | 5%        | 30%            | 120s     | Low |

### Security Model
- **AES-256-GCM** wallet encryption with PBKDF2 key derivation (100k iterations, SHA-256)
- **Password required at runtime** — never stored, never logged
- **Dry-run by default** — `--live` flag + typed confirmation for real trades
- **Key sanitization** — private keys auto-redacted in all log output
- **Minimum SOL reserve** — always keeps 0.01 SOL for transaction fees
- **Separate concerns** — agent logic never touches raw keys; wallet module handles all crypto

### Terminal UI (TUI)
The `run` command launches a full-screen terminal interface:
- **Alt screen buffer** — clean entry/exit, no terminal pollution
- **Live log feed** — color-coded entries (decisions, trades, errors, info)
- **Animated indicators** — busy animation while waiting for AI response
- **Viewport scrolling** — up/down/pageup/pagedown/home/end
- **Slash commands** — `/status`, `/balance`, `/strategy`, `/stop`, `/quit`, `/help`
- **Ctrl+C** — graceful shutdown (stops agent, restores terminal)

### Multi-Agent Support
Multiple agents can run simultaneously, each with:
- Independent wallet and keypair
- Independent strategy and confidence thresholds
- Independent abort controller (stop one without affecting others)
- Independent log file per day
- Shared config (RPC endpoint, API key)

### Quick Start
```bash
npm install && npm run build && npm link
solana-agent config set grokApiKey gsk_YOUR_KEY
solana-agent wallet create alice
solana-agent wallet fund alice
solana-agent run alice -s conservative
```

### Supported Tokens
SOL, USDC, USDT, BONK, JUP, RAY, ORCA, PYTH

### Dependencies
- `@solana/web3.js` — Solana blockchain interaction
- `@solana/spl-token` — SPL token account queries
- `commander` — CLI framework
- `chalk` — Terminal colors
- `ora` — Spinners for non-TUI commands
- `dotenv` — Environment variable loading
