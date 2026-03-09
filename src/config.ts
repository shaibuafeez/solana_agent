/**
 * Configuration management — persists to ~/.solana-agent/config.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AppConfig } from './types.js';

const DATA_DIR = path.join(os.homedir(), '.solana-agent');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WALLETS_DIR = path.join(DATA_DIR, 'wallets');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

function ensureDirs(): void {
  for (const dir of [DATA_DIR, WALLETS_DIR, LOGS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

interface StoredConfig {
  grokApiKey?: string;
  grokModel?: string;
  solanaRpcUrl?: string;
  solanaNetwork?: string;
  jupiterApiKey?: string;
}

function readStored(): StoredConfig {
  ensureDirs();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStored(cfg: StoredConfig): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export function loadConfig(): AppConfig {
  const stored = readStored();
  return {
    grokApiKey: stored.grokApiKey || process.env.GROK_API_KEY || '',
    grokModel: stored.grokModel || process.env.GROK_MODEL || 'llama-3.3-70b-versatile',
    solanaRpcUrl: stored.solanaRpcUrl || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    solanaNetwork: (stored.solanaNetwork || process.env.SOLANA_NETWORK || 'devnet') as 'mainnet' | 'devnet',
    jupiterApiKey: stored.jupiterApiKey || process.env.JUPITER_API_KEY || '',
    dataDir: DATA_DIR,
    walletsDir: WALLETS_DIR,
    logsDir: LOGS_DIR,
  };
}

export function setConfigValue(key: string, value: string): void {
  const stored = readStored();
  (stored as Record<string, unknown>)[key] = value;
  writeStored(stored);
}

export function getConfigValue(key: string): string | undefined {
  const stored = readStored();
  return (stored as Record<string, unknown>)[key] as string | undefined;
}

export function showConfig(): Record<string, string> {
  const config = loadConfig();
  return {
    grokApiKey: config.grokApiKey ? `${config.grokApiKey.slice(0, 6)}...${config.grokApiKey.slice(-4)}` : '(not set)',
    grokModel: config.grokModel,
    solanaRpcUrl: config.solanaRpcUrl,
    solanaNetwork: config.solanaNetwork,
    jupiterApiKey: config.jupiterApiKey ? '***' : '(not set)',
    dataDir: config.dataDir,
  };
}
