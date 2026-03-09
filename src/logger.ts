/**
 * File + terminal logger with key sanitization
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SENSITIVE_PATTERNS = [
  /0x[a-fA-F0-9]{64}/g,         // Private keys
  /[1-9A-HJ-NP-Za-km-z]{87,88}/g, // Solana secret keys (base58)
];

function sanitize(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => match.slice(0, 6) + '...' + match.slice(-4));
  }
  return result;
}

export class Logger {
  private logFile: string;
  private stream: fs.WriteStream;

  constructor(logsDir: string, agentName: string) {
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = path.join(logsDir, `${agentName}-${date}.log`);
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  private write(level: string, message: string): void {
    const ts = new Date().toISOString();
    const sanitized = sanitize(message);
    const line = `[${ts}] [${level}] ${sanitized}\n`;
    this.stream.write(line);
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  trade(message: string): void {
    this.write('TRADE', message);
  }

  ai(message: string): void {
    this.write('AI', message);
  }

  close(): void {
    this.stream.end();
  }

  getLogFile(): string {
    return this.logFile;
  }
}
