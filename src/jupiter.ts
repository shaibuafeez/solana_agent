/**
 * Jupiter DEX integration — quotes + swap transaction building
 * Direct API calls (no proxy needed for CLI)
 *
 * Endpoint strategy:
 *   - If user provides a jupiterApiKey → use official api.jup.ag (paid)
 *   - Otherwise → use public.jupiterapi.com (free, 10 req/s, 0.2% platform fee)
 *
 * Token prices via DexScreener (free, no key required)
 */

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { AppConfig } from './types.js';

const JUPITER_PAID_API = 'https://api.jup.ag/swap/v1';
const JUPITER_FREE_API = 'https://public.jupiterapi.com';

function getBaseUrl(apiKey?: string): string {
  return apiKey ? JUPITER_PAID_API : JUPITER_FREE_API;
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: any[];
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50,
  apiKey?: string
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
  });

  const base = getBaseUrl(apiKey);
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(`${base}/quote?${params}`, { headers });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${err}`);
  }

  return response.json() as Promise<JupiterQuote>;
}

export async function buildSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
  apiKey?: string
): Promise<VersionedTransaction> {
  const base = getBaseUrl(apiKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(`${base}/swap`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Jupiter swap build failed (${response.status}): ${err}`);
  }

  const { swapTransaction } = await response.json() as { swapTransaction: string };
  const txBuf = Buffer.from(swapTransaction, 'base64');
  return VersionedTransaction.deserialize(txBuf);
}

/**
 * Get token price in USD via DexScreener (free, no key required)
 */
export async function getTokenPrice(mint: string): Promise<number> {
  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    if (!response.ok) return 0;
    const pairs = await response.json() as any[];
    if (!Array.isArray(pairs) || pairs.length === 0) return 0;
    // Pick the most liquid pair
    const best = pairs.reduce((a: any, b: any) =>
      parseFloat(b.liquidity?.usd || '0') > parseFloat(a.liquidity?.usd || '0') ? b : a
    );
    return parseFloat(best.priceUsd || '0');
  } catch {
    return 0;
  }
}

/**
 * Execute a swap: quote → build → sign → submit
 * Returns tx signature or null if dryRun
 */
export async function executeSwap(
  config: AppConfig,
  connection: Connection,
  keypair: import('@solana/web3.js').Keypair,
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  dryRun: boolean = true
): Promise<{ quote: JupiterQuote; txSignature: string | null }> {
  const quote = await getQuote(inputMint, outputMint, amountLamports, 50, config.jupiterApiKey);

  if (dryRun) {
    return { quote, txSignature: null };
  }

  const tx = await buildSwapTransaction(quote, keypair.publicKey.toBase58(), config.jupiterApiKey);
  tx.sign([keypair]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return { quote, txSignature: sig };
}
