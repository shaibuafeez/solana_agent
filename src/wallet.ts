/**
 * Wallet management — encrypted Solana keypairs stored on disk
 * AES-256-GCM with PBKDF2-derived key (100k iterations, SHA-256)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import type { EncryptedWallet } from './types.js';

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

function encrypt(data: Uint8Array, password: string): { encrypted: string; salt: string; iv: string } {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: Buffer.concat([encrypted, authTag]).toString('base64'),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
  };
}

function decrypt(encryptedBase64: string, salt: string, iv: string, password: string): Uint8Array {
  const saltBuf = Buffer.from(salt, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  const key = deriveKey(password, saltBuf);

  const raw = Buffer.from(encryptedBase64, 'base64');
  const authTag = raw.subarray(raw.length - 16);
  const encrypted = raw.subarray(0, raw.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAuthTag(authTag);

  return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
}

export function createWallet(
  name: string,
  password: string,
  walletsDir: string,
  network: 'mainnet' | 'devnet' = 'devnet'
): EncryptedWallet {
  const filePath = path.join(walletsDir, `${name}.json`);
  if (fs.existsSync(filePath)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  const keypair = Keypair.generate();
  const { encrypted, salt, iv } = encrypt(keypair.secretKey, password);

  const wallet: EncryptedWallet = {
    name,
    publicKey: keypair.publicKey.toBase58(),
    encryptedSecretKey: encrypted,
    salt,
    iv,
    createdAt: new Date().toISOString(),
    network,
  };

  fs.writeFileSync(filePath, JSON.stringify(wallet, null, 2));
  return wallet;
}

export function loadWallet(name: string, walletsDir: string): EncryptedWallet {
  const filePath = path.join(walletsDir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Wallet "${name}" not found`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function unlockWallet(wallet: EncryptedWallet, password: string): Keypair {
  try {
    const secretKey = decrypt(wallet.encryptedSecretKey, wallet.salt, wallet.iv, password);
    return Keypair.fromSecretKey(secretKey);
  } catch {
    throw new Error('Invalid password or corrupted wallet');
  }
}

export function listWallets(walletsDir: string): EncryptedWallet[] {
  if (!fs.existsSync(walletsDir)) return [];
  const files = fs.readdirSync(walletsDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(walletsDir, f), 'utf-8'));
    return data as EncryptedWallet;
  });
}

export function exportKeypair(wallet: EncryptedWallet, password: string): string {
  const keypair = unlockWallet(wallet, password);
  return `[${Array.from(keypair.secretKey).join(',')}]`;
}

export function walletExists(name: string, walletsDir: string): boolean {
  return fs.existsSync(path.join(walletsDir, `${name}.json`));
}
