/**
 * Trading strategies + AI decision loop
 */

import type { AIDecision, TradingStrategy, MarketData, AppConfig, Message } from './types.js';
import { chatCompletion } from './compute.js';

export const STRATEGIES: Record<string, TradingStrategy> = {
  conservative: {
    name: 'conservative',
    description: 'Low risk — small trades, high confidence required',
    maxTradePercent: 10,
    minConfidence: 0.8,
    intervalMs: 60_000,
    systemPrompt: `You are a conservative Solana trading agent. You prioritize capital preservation.
Only recommend trades when you have very high confidence (0.8+).
Maximum position size: 10% of portfolio per trade.
Prefer stablecoins and blue-chip tokens (SOL, USDC, JUP, RAY).
Avoid meme coins and low-liquidity tokens.
Always consider price impact and slippage.`,
  },
  momentum: {
    name: 'momentum',
    description: 'Medium risk — follows trends, moderate confidence',
    maxTradePercent: 25,
    minConfidence: 0.6,
    intervalMs: 30_000,
    systemPrompt: `You are a momentum-based Solana trading agent. You follow market trends.
Recommend trades when confidence is moderate or higher (0.6+).
Maximum position size: 25% of portfolio per trade.
Look for trending tokens with increasing volume.
Consider both major tokens and trending meme coins.
React quickly to market movements.`,
  },
  dca: {
    name: 'dca',
    description: 'Dollar cost averaging — steady accumulation',
    maxTradePercent: 5,
    minConfidence: 0.3,
    intervalMs: 120_000,
    systemPrompt: `You are a DCA (Dollar Cost Averaging) Solana trading agent.
Your goal is steady accumulation of promising tokens over time.
Recommend small, regular buys (max 5% per trade).
Low confidence threshold (0.3) since you're averaging in over time.
Prefer SOL, USDC, and top ecosystem tokens.
Rarely recommend sells — only if fundamentals change dramatically.`,
  },
};

const DECISION_PROMPT = `Analyze the following market data and decide on a trading action.

PORTFOLIO:
{portfolio}

AVAILABLE TOKENS: SOL, USDC, USDT, BONK, JUP, RAY, ORCA, PYTH

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "action": "buy" | "sell" | "hold",
  "fromToken": "TOKEN_SYMBOL",
  "toToken": "TOKEN_SYMBOL",
  "amountPercent": <number 1-100>,
  "reasoning": "brief explanation",
  "confidence": <number 0.0-1.0>
}

Rules:
- amountPercent is percentage of the fromToken balance to trade
- For "hold", set fromToken and toToken to "SOL", amountPercent to 0
- confidence must honestly reflect your certainty (0.0 = no idea, 1.0 = certain)
- Consider gas fees (keep at least 0.01 SOL for fees)
- Consider price impact for large trades`;

function formatPortfolio(data: MarketData): string {
  const lines = data.tokenBalances.map(
    (t) => `  ${t.symbol}: ${t.uiBalance} (${t.name})`
  );
  return lines.join('\n');
}

export function getStrategy(name: string): TradingStrategy {
  const strategy = STRATEGIES[name];
  if (!strategy) {
    const available = Object.keys(STRATEGIES).join(', ');
    throw new Error(`Unknown strategy "${name}". Available: ${available}`);
  }
  return strategy;
}

export async function getAIDecision(
  config: AppConfig,
  strategy: TradingStrategy,
  marketData: MarketData
): Promise<AIDecision> {
  const portfolio = formatPortfolio(marketData);
  const userMessage = DECISION_PROMPT.replace('{portfolio}', portfolio);

  const messages: Message[] = [{ role: 'user', content: userMessage }];
  const { text } = await chatCompletion(config, messages, strategy.systemPrompt);

  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }
  // Also try to find raw JSON object
  const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    jsonStr = braceMatch[0];
  }

  let decision: AIDecision;
  try {
    decision = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse AI decision: ${text.slice(0, 200)}`);
  }

  // Validate fields
  if (!['buy', 'sell', 'hold'].includes(decision.action)) {
    throw new Error(`Invalid action: ${decision.action}`);
  }
  decision.confidence = Math.max(0, Math.min(1, Number(decision.confidence) || 0));
  decision.amountPercent = Math.max(0, Math.min(strategy.maxTradePercent, Number(decision.amountPercent) || 0));

  return decision;
}
