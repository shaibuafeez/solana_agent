/**
 * Solana connection, balances, airdrop, token registry
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import type { AppConfig, TokenBalance } from './types.js';

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** Well-known mainnet SPL tokens */
export const TOKEN_REGISTRY: Record<string, TokenInfo> = {
  SOL: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5 },
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6 },
  RAY: { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', name: 'Raydium', decimals: 6 },
  ORCA: { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', name: 'Orca', decimals: 6 },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', name: 'Pyth Network', decimals: 6 },
};

export function getConnection(config: AppConfig): Connection {
  return new Connection(config.solanaRpcUrl, 'confirmed');
}

export function resolveToken(symbolOrMint: string): TokenInfo | null {
  const upper = symbolOrMint.toUpperCase();
  if (TOKEN_REGISTRY[upper]) return TOKEN_REGISTRY[upper];
  const byMint = Object.values(TOKEN_REGISTRY).find((t) => t.mint === symbolOrMint);
  return byMint || null;
}

export async function getSolBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function getTokenBalances(connection: Connection, owner: PublicKey): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];

  // SOL balance
  const solLamports = await connection.getBalance(owner);
  balances.push({
    mint: TOKEN_REGISTRY.SOL.mint,
    symbol: 'SOL',
    name: 'Solana',
    balance: solLamports / LAMPORTS_PER_SOL,
    decimals: 9,
    uiBalance: (solLamports / LAMPORTS_PER_SOL).toFixed(4),
  });

  // SPL token balances
  for (const token of Object.values(TOKEN_REGISTRY)) {
    if (token.symbol === 'SOL') continue;
    try {
      const ata = await getAssociatedTokenAddress(new PublicKey(token.mint), owner);
      const account = await getAccount(connection, ata);
      const balance = Number(account.amount) / Math.pow(10, token.decimals);
      if (balance > 0) {
        balances.push({
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          balance,
          decimals: token.decimals,
          uiBalance: balance.toFixed(token.decimals > 6 ? 4 : 2),
        });
      }
    } catch {
      // Token account doesn't exist — zero balance, skip
    }
  }

  return balances;
}

/**
 * Request devnet airdrop with retry logic.
 * The public devnet faucet is rate-limited — retries with backoff on failure.
 */
export async function requestAirdrop(connection: Connection, publicKey: PublicKey, solAmount: number = 1): Promise<string> {
  const maxRetries = 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const sig = await connection.requestAirdrop(publicKey, solAmount * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      return sig;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = 2000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error(
    `Airdrop failed after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}. ` +
    `The public devnet faucet may be rate-limited. Try again later or use https://faucet.solana.com/`
  );
}

export async function sendVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  keypair: Keypair
): Promise<string> {
  transaction.sign([keypair]);
  const sig = await connection.sendTransaction(transaction, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

export function shortenAddress(address: string, chars: number = 4): string {
  if (address.length < chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
