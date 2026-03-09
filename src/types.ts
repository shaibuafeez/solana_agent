/**
 * Type definitions for Solana Agent Wallet
 */

export interface AppConfig {
  grokApiKey: string;
  grokModel: string;
  solanaRpcUrl: string;
  solanaNetwork: 'mainnet' | 'devnet';
  jupiterApiKey: string;
  dataDir: string;
  walletsDir: string;
  logsDir: string;
}

export interface EncryptedWallet {
  name: string;
  publicKey: string;
  encryptedSecretKey: string;
  salt: string;
  iv: string;
  createdAt: string;
  network: 'mainnet' | 'devnet';
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiBalance: string;
}

export interface AIDecision {
  action: 'buy' | 'sell' | 'hold';
  fromToken: string;
  toToken: string;
  amountPercent: number;
  reasoning: string;
  confidence: number;
}

export interface TradingStrategy {
  name: string;
  description: string;
  maxTradePercent: number;
  minConfidence: number;
  intervalMs: number;
  systemPrompt: string;
}

export interface AgentState {
  walletName: string;
  strategy: string;
  running: boolean;
  abortController: AbortController;
  startedAt: string;
  tradesExecuted: number;
  lastDecision: AIDecision | null;
  dryRun: boolean;
}

export interface TradeResult {
  success: boolean;
  action: string;
  fromToken: string;
  toToken: string;
  amountIn: string;
  amountOut?: string;
  txSignature?: string;
  error?: string;
  dryRun: boolean;
}

export interface MarketData {
  solBalance: number;
  tokenBalances: TokenBalance[];
  timestamp: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
