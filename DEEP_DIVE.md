# Deep Dive: Solana Agent Wallet

A comprehensive technical analysis of the wallet design, security model, AI agent interaction, and scalability architecture.

---

## 1. Problem Statement

AI agents on Solana need wallets that they control — capable of holding funds, signing transactions, and interacting with protocols without human intervention at every step. This creates unique challenges:

- **Key management**: Agents need access to private keys, but keys must be protected at rest
- **Autonomous signing**: Transactions must be signed programmatically without manual approval
- **Risk containment**: An AI making financial decisions needs guardrails to prevent catastrophic losses
- **Observability**: Humans need to monitor and control what autonomous agents are doing

This project solves all four with an encrypted wallet system, strategy-bounded AI trading, dry-run defaults, and a full-screen terminal UI.

---

## 2. Wallet Design

### 2.1 Encryption Architecture

Each wallet is a JSON file stored at `~/.solana-agent/wallets/<name>.json`:

```json
{
  "name": "alice",
  "publicKey": "7xKXt...",
  "encryptedSecretKey": "<base64>",
  "salt": "<base64>",
  "iv": "<base64>",
  "createdAt": "2025-01-15T...",
  "network": "devnet"
}
```

**Encryption pipeline:**

```
Password → PBKDF2(SHA-256, 100k iterations, 32-byte salt) → AES key (256-bit)
SecretKey + AES key + IV → AES-256-GCM → EncryptedSecretKey + AuthTag
```

Key design decisions:
- **AES-256-GCM** (not CBC): Provides both confidentiality and integrity. The authentication tag detects any tampering with the ciphertext — a wrong password or corrupted file produces a clear error, not garbage output.
- **PBKDF2 with 100k iterations**: Deliberately slow key derivation makes brute-force attacks on weak passwords computationally expensive. 100k iterations takes ~100ms on modern hardware — imperceptible to users, prohibitive to attackers.
- **32-byte random salt**: Prevents rainbow table attacks. Each wallet has a unique salt, so identical passwords produce different keys.
- **16-byte random IV**: Ensures the same plaintext encrypted twice produces different ciphertext.

### 2.2 Key Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CREATE      │     │   UNLOCK      │     │   USE         │
│               │     │               │     │               │
│ Keypair.gen() │────▶│ Password +    │────▶│ Keypair in    │
│ Encrypt to    │     │ PBKDF2 +      │     │ memory only   │
│ disk          │     │ AES-GCM       │     │ (never saved  │
│               │     │ decrypt       │     │  unencrypted) │
└──────────────┘     └──────────────┘     └──────────────┘
```

Critical properties:
- **Password never stored**: Not on disk, not in config, not in environment variables. Required interactively at runtime.
- **Secret key only in memory**: The decrypted `Keypair` exists only in the Node.js process. When the process exits, the key is gone.
- **No key export without confirmation**: The `wallet export` command requires typing "I UNDERSTAND" + password.

### 2.3 Programmatic Wallet Creation

```typescript
const keypair = Keypair.generate();  // Ed25519 keypair
const { encrypted, salt, iv } = encrypt(keypair.secretKey, password);
// Write to ~/.solana-agent/wallets/<name>.json
```

This satisfies the bounty requirement "create a wallet programmatically" — no manual key generation, no importing from external sources. The wallet is born inside the agent system.

---

## 3. Autonomous Transaction Signing

### 3.1 The Signing Flow

When the AI decides to trade, the signing happens in a pipeline with no human intervention:

```
AI Decision → Jupiter Quote → Build VersionedTransaction → Sign → Submit → Confirm
```

Specifically:
1. **Quote**: `GET /quote?inputMint=...&outputMint=...&amount=...` — Jupiter finds the best route
2. **Build**: `POST /swap` with the quote — Jupiter returns a serialized `VersionedTransaction`
3. **Sign**: `transaction.sign([keypair])` — the agent's keypair signs the transaction
4. **Submit**: `connection.sendTransaction(tx)` — submitted to Solana RPC
5. **Confirm**: `connection.confirmTransaction(sig, 'confirmed')` — wait for finality

The keypair is the only signer. No multi-sig, no approval flow — fully autonomous.

### 3.2 Why VersionedTransaction

Jupiter returns `VersionedTransaction` (v0) rather than legacy transactions because:
- **Address Lookup Tables**: Reduces transaction size by referencing common accounts via lookup tables
- **More instructions**: Can fit more complex routes (multi-hop swaps) within the 1232-byte limit
- **Standard pattern**: All modern Solana DEXs use versioned transactions

### 3.3 Safety Mechanisms

Even though signing is autonomous, multiple layers prevent catastrophic trades:

| Layer | Mechanism | Effect |
|-------|-----------|--------|
| **Strategy bounds** | `maxTradePercent` | Never trade more than X% of a token balance |
| **Confidence threshold** | `minConfidence` | AI must be sufficiently certain before executing |
| **SOL reserve** | Hard-coded 0.01 SOL minimum | Always keeps enough for future transaction fees |
| **Dry-run default** | `--live` flag required | No real trades without explicit opt-in |
| **Live confirmation** | Must type "CONFIRM" | Additional gate before live mode starts |
| **Slippage protection** | 50 bps default | Jupiter rejects if price moves >0.5% during execution |

---

## 4. AI Agent Integration

### 4.1 Decision Architecture

The AI doesn't have direct access to the wallet or blockchain. It receives market data and returns a structured decision:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  MARKET DATA  │     │   GROQ AI     │     │  EXECUTION    │
│               │     │               │     │               │
│ SOL: 2.5      │────▶│ System prompt │────▶│ Parse JSON    │
│ USDC: 100.00  │     │ + portfolio   │     │ Validate      │
│ JUP: 50.25    │     │ → JSON output │     │ Clamp values  │
│               │     │               │     │ Execute swap  │
└──────────────┘     └──────────────┘     └──────────────┘
```

This separation is intentional:
- **AI has no key access**: It never sees the private key or signs anything
- **AI has no RPC access**: It can't submit arbitrary transactions
- **AI output is validated**: Action, confidence, and amount are all clamped to strategy bounds
- **AI output is parsed defensively**: JSON extraction handles markdown code blocks, malformed responses

### 4.2 Prompt Engineering

Each strategy has a system prompt that constrains the AI's behavior:

```
Conservative: "Only recommend trades when you have very high confidence (0.8+).
              Maximum position size: 10% of portfolio per trade.
              Prefer stablecoins and blue-chip tokens."

Momentum:     "Look for trending tokens with increasing volume.
              Consider both major tokens and trending meme coins.
              React quickly to market movements."

DCA:          "Steady accumulation of promising tokens over time.
              Small, regular buys (max 5% per trade).
              Rarely recommend sells."
```

The user prompt provides portfolio data and demands strict JSON output:

```json
{
  "action": "buy" | "sell" | "hold",
  "fromToken": "SOL",
  "toToken": "USDC",
  "amountPercent": 10,
  "reasoning": "...",
  "confidence": 0.85
}
```

### 4.3 Response Validation

Even with a well-crafted prompt, AI responses need validation:

```typescript
// Extract JSON from markdown code blocks if present
const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
// Fallback: find raw JSON object
const braceMatch = text.match(/\{[\s\S]*\}/);

// Validate action
if (!['buy', 'sell', 'hold'].includes(decision.action)) throw ...

// Clamp values to strategy bounds
decision.confidence = Math.max(0, Math.min(1, Number(decision.confidence)));
decision.amountPercent = Math.max(0, Math.min(strategy.maxTradePercent, Number(decision.amountPercent)));
```

The AI cannot exceed strategy bounds — even if it returns `amountPercent: 100`, it gets clamped to the strategy's `maxTradePercent`.

### 4.4 Groq API Integration

The AI backend uses Groq (GroqCloud) via the OpenAI-compatible API:

```typescript
const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.grokApiKey}`,
  },
  body: JSON.stringify({ model: config.grokModel, stream: false, messages }),
});
```

Non-streaming mode is used because we need the complete JSON response to parse the trading decision. The entire compute module is ~48 lines — deliberately simple with no caching, no retries, no complexity beyond the API call itself.

---

## 5. Security Considerations

### 5.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| **Disk compromise** | Wallet encrypted with AES-256-GCM; attacker needs password |
| **Memory dump** | Keys exist in memory only during process lifetime |
| **Log leakage** | All logs sanitized — private keys auto-redacted |
| **AI manipulation** | AI has no key/RPC access; output validated and clamped |
| **Runaway trades** | Strategy bounds, confidence thresholds, SOL reserve |
| **Network MITM** | HTTPS for all external calls (Groq API, Jupiter, Solana RPC) |
| **Config theft** | API key in ~/.solana-agent/config.json (0600 permissions recommended) |

### 5.2 What This Prototype Does NOT Do

Being honest about security boundaries is important for a prototype:

- **No HSM/secure enclave**: Keys are in process memory, vulnerable to sophisticated memory attacks
- **No key rotation**: Once created, a wallet keeps the same keypair
- **No spending limits per time period**: Only per-trade percentage limits
- **No multi-sig**: Single keypair signs everything
- **No on-chain governance**: All decisions are off-chain AI → single signer
- **No rate limiting on AI calls**: Could rack up API costs if loop interval is very short
- **No formal audit**: This is a prototype, not production-grade financial software

### 5.3 Recommended Hardening for Production

1. **OS-level key protection**: Use `keytar` or OS keychain instead of file-based encryption
2. **Spending caps**: Daily/weekly maximum trade volume per wallet
3. **Alert thresholds**: Notify human when confidence is low or losses accumulate
4. **Multi-sig for large trades**: Require human co-signature above a threshold
5. **API key rotation**: Support key rotation without wallet recreation
6. **Audit logging**: Append-only logs with tamper detection

---

## 6. Multi-Agent Scalability

### 6.1 Current Architecture

```
Process
├── Agent "alice" (conservative, devnet)
│   ├── Own AbortController
│   ├── Own Logger (alice-2025-01-15.log)
│   ├── Own Keypair (in memory)
│   └── Own trading loop (60s interval)
│
├── Agent "bob" (momentum, devnet)
│   ├── Own AbortController
│   ├── Own Logger (bob-2025-01-15.log)
│   ├── Own Keypair (in memory)
│   └── Own trading loop (30s interval)
│
└── Shared: Config, RPC connection, Groq API key
```

Each agent is independent:
- **Start/stop independently**: `stopAgent("alice")` doesn't affect "bob"
- **Independent error handling**: One agent crashing doesn't take down others
- **Independent logging**: Each wallet has its own log files
- **Shared resources**: RPC connection and API key are shared (no duplication)

### 6.2 Scaling Considerations

| Dimension | Current | Production Path |
|-----------|---------|----------------|
| **Agents per process** | ~10 (limited by event loop) | Worker threads or separate processes |
| **RPC rate limits** | Public devnet (rate limited) | Dedicated RPC (Helius, Quicknode) |
| **AI API costs** | Per-call billing | Batch decisions or local model |
| **State persistence** | In-memory Map | Redis or database for cross-process state |
| **Coordination** | None (independent) | Message queue for portfolio-level decisions |

### 6.3 Test Harness

The current system supports running multiple agents as a test harness:

```bash
# Terminal 1: Start conservative agent
solana-agent run alice -s conservative

# Terminal 2: Start momentum agent
solana-agent run bob -s momentum

# Terminal 3: Check status
solana-agent status
```

Each terminal gets its own full-screen TUI showing that agent's activity.

---

## 7. Terminal UI Design

### 7.1 Why a Full-Screen TUI

Autonomous agents need observability. A full-screen TUI provides:

- **Live feed**: Every AI decision, trade execution, and error is visible immediately
- **No scroll-back pollution**: Alt screen buffer means your terminal history is preserved
- **Interactive control**: Slash commands let you query and control the agent without stopping it
- **Context line**: Always shows current model, wallet, and strategy at the bottom

### 7.2 Architecture

```
┌─────────────────────────────────────────────┐
│ ╭───────────────────────────────────╮        │ ← Header card
│ │ SOLANA AGENT • powered by groq   │        │
│ │ STATUS Ready                     │        │
│ ╰───────────────────────────────────╯        │
│                                              │
│ · Agent started: alice                       │ ← Log entries
│ · Strategy: conservative — Low risk          │    (scrollable viewport)
│ · Balances: SOL=2.5000                       │
│ ● HOLD (confidence: 45%) — market stable     │
│ · Next cycle in 60s                          │
│                                              │
│ ─────────────────────────────────────────    │ ← Footer
│                                              │
│ › enter a command or chat with the agent...  │ ← Input bar
│                                              │
│ llama-3.3-70b-versatile  •  alice  •  conservative │ ← Context line
└─────────────────────────────────────────────┘
```

Key implementation details:
- **Raw mode**: `process.stdin.setRawMode(true)` — captures individual keypresses
- **Alt screen**: `\x1b[?1049h` on start, `\x1b[?1049l` on stop — preserves terminal history
- **Hidden cursor**: `\x1b[?25l` — no blinking cursor during rendering
- **Full repaint**: `\x1b[2J\x1b[H` — clears and redraws on every update (simple, flicker-free at terminal speeds)

---

## 8. File-by-File Walkthrough

| File | Lines | Purpose |
|------|-------|---------|
| `wallet.ts` | 113 | AES-256-GCM encryption, PBKDF2, create/load/unlock/export |
| `solana.ts` | 140 | Connection management, SOL+SPL balances, token registry, airdrop |
| `jupiter.ts` | 137 | Quote, swap tx build, DexScreener prices, full swap execution |
| `compute.ts` | 48 | Groq API client — single `chatCompletion()` function |
| `strategy.ts` | 129 | 3 strategies, prompt engineering, AI decision parsing + validation |
| `agent.ts` | 227 | Multi-agent orchestrator, trade execution, TUI integration |
| `ui.ts` | 530 | TerminalUI class + standalone helpers for non-TUI commands |
| `index.ts` | 293 | Commander.js CLI, TUI wiring, slash commands, password prompting |
| `logger.ts` | 65 | File logger with automatic key sanitization |
| `config.ts` | 80 | Config persistence (~/.solana-agent/config.json) |
| `types.ts` | 89 | TypeScript interfaces for all data structures |

**Total**: ~1,851 lines of TypeScript — compact enough to audit, comprehensive enough to be useful.

---

## 9. Summary

This project demonstrates a working agentic wallet system on Solana that:

1. **Creates wallets programmatically** with strong encryption (AES-256-GCM, PBKDF2)
2. **Signs transactions automatically** via Jupiter DEX without human intervention
3. **Holds SOL and SPL tokens** with balance tracking across 8 registered tokens
4. **Interacts with a real protocol** (Jupiter DEX — the largest Solana DEX aggregator)
5. **Separates agent logic from wallet operations** — the AI never touches keys
6. **Supports multiple independent agents** with per-wallet isolation
7. **Provides observability** through a full-screen TUI with live updates and interactive commands
8. **Defaults to safety** — dry-run mode, strategy bounds, confidence thresholds, SOL reserves

The prototype works on Solana devnet today and is designed so that each component (wallet encryption, AI provider, DEX integration, UI) can be swapped independently for production use.
