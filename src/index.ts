#!/usr/bin/env node

/**
 * solana-agent — Autonomous Solana trading agent powered by Groq AI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'node:readline';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

import { loadConfig, setConfigValue, showConfig } from './config.js';
import { createWallet, loadWallet, unlockWallet, listWallets, exportKeypair, walletExists } from './wallet.js';
import { getConnection, getSolBalance, getTokenBalances, requestAirdrop, shortenAddress } from './solana.js';
import { startAgent, stopAgent, getAgentStatus } from './agent.js';
import { STRATEGIES } from './strategy.js';
import { TerminalUI, showTitle, showSuccess, showError, showWarning, showKeyValue, showTable, showDivider, showAgent, showInfo } from './ui.js';
import { PublicKey } from '@solana/web3.js';

const program = new Command();

program
  .name('solana-agent')
  .description('Autonomous Solana trading agent powered by Groq AI')
  .version('0.2.0');

// ─── wallet commands ────────────────────────────────────────────────

const wallet = program.command('wallet').description('Wallet management');

wallet
  .command('create <name>')
  .description('Create a new encrypted agent wallet')
  .action(async (name: string) => {
    const config = loadConfig();
    if (walletExists(name, config.walletsDir)) {
      showError(`Wallet "${name}" already exists`);
      process.exit(1);
    }

    const password = await promptPassword('Set wallet password: ');
    const confirm = await promptPassword('Confirm password: ');
    if (password !== confirm) {
      showError('Passwords do not match');
      process.exit(1);
    }

    const spinner = ora('Creating wallet...').start();
    try {
      const w = createWallet(name, password, config.walletsDir, config.solanaNetwork);
      spinner.succeed('Wallet created');
      showTitle(`Wallet: ${name}`);
      showKeyValue('Public Key', w.publicKey);
      showKeyValue('Network', w.network);
      showKeyValue('Created', w.createdAt);
      showWarning('Store your password securely — it cannot be recovered!');
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

wallet
  .command('list')
  .description('List all wallets')
  .action(() => {
    const config = loadConfig();
    const wallets = listWallets(config.walletsDir);
    if (wallets.length === 0) {
      showInfo('No wallets found. Create one with: solana-agent wallet create <name>');
      return;
    }
    showTitle('Wallets');
    for (const w of wallets) {
      console.log(`  ${chalk.bold(w.name)}  ${chalk.gray(shortenAddress(w.publicKey))}  ${chalk.gray(w.network)}  ${chalk.gray(w.createdAt.slice(0, 10))}`);
    }
  });

wallet
  .command('fund <name>')
  .description('Airdrop devnet SOL')
  .option('-a, --amount <sol>', 'Amount of SOL to airdrop', '1')
  .action(async (name: string, opts: { amount: string }) => {
    const config = loadConfig();
    if (config.solanaNetwork !== 'devnet') {
      showError('Airdrop only works on devnet');
      process.exit(1);
    }

    const w = loadWallet(name, config.walletsDir);
    const connection = getConnection(config);
    const spinner = ora(`Airdropping ${opts.amount} SOL...`).start();
    try {
      const sig = await requestAirdrop(connection, new PublicKey(w.publicKey), parseFloat(opts.amount));
      spinner.succeed(`Airdropped ${opts.amount} SOL`);
      showKeyValue('Signature', sig);
    } catch (err: any) {
      spinner.fail(`Airdrop failed: ${err.message}`);
      process.exit(1);
    }
  });

wallet
  .command('balance <name>')
  .description('Check SOL + SPL token balances')
  .action(async (name: string) => {
    const config = loadConfig();
    const w = loadWallet(name, config.walletsDir);
    const connection = getConnection(config);
    const spinner = ora('Fetching balances...').start();
    try {
      const balances = await getTokenBalances(connection, new PublicKey(w.publicKey));
      spinner.stop();
      showTitle(`Balances: ${name}`);
      showKeyValue('Address', w.publicKey);
      showKeyValue('Network', config.solanaNetwork);
      showDivider();
      for (const b of balances) {
        showKeyValue(b.symbol, `${b.uiBalance} ${b.name}`);
      }
      if (balances.length === 1) {
        showInfo('Only SOL found. Fund wallet or swap to get other tokens.');
      }
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

wallet
  .command('export <name>')
  .description('Export keypair (DANGER: prints secret key)')
  .action(async (name: string) => {
    const config = loadConfig();
    const w = loadWallet(name, config.walletsDir);
    showWarning('This will display your SECRET KEY. Never share it!');
    const confirm = await promptLine('Type "I UNDERSTAND" to continue: ');
    if (confirm !== 'I UNDERSTAND') {
      showInfo('Cancelled');
      return;
    }
    const password = await promptPassword('Wallet password: ');
    try {
      const exported = exportKeypair(w, password);
      console.log(`\n${exported}\n`);
    } catch (err: any) {
      showError(err.message);
      process.exit(1);
    }
  });

// ─── agent commands ─────────────────────────────────────────────────

program
  .command('run <name>')
  .description('Start autonomous AI trading agent')
  .option('-s, --strategy <name>', 'Trading strategy', 'conservative')
  .option('--live', 'Execute real trades (default is dry-run)')
  .action(async (name: string, opts: { strategy: string; live?: boolean }) => {
    const config = loadConfig();

    if (!config.grokApiKey) {
      showError('Groq API key not set. Run: solana-agent config set grokApiKey <key>');
      process.exit(1);
    }

    const w = loadWallet(name, config.walletsDir);
    const password = await promptPassword('Wallet password: ');

    const spinner = ora('Unlocking wallet...').start();
    let keypair;
    try {
      keypair = unlockWallet(w, password);
      spinner.succeed('Wallet unlocked');
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }

    const dryRun = !opts.live;
    const strategy = STRATEGIES[opts.strategy];
    if (!strategy) {
      showError(`Unknown strategy: ${opts.strategy}`);
      showInfo(`Available: ${Object.keys(STRATEGIES).join(', ')}`);
      process.exit(1);
    }

    if (!dryRun) {
      showWarning('LIVE MODE: Real trades will be executed with real funds!');
      const confirm = await promptLine('Type "CONFIRM" to start: ');
      if (confirm !== 'CONFIRM') {
        showInfo('Cancelled');
        return;
      }
    }

    // Create full-screen TUI
    const ui = new TerminalUI({
      model: config.grokModel,
      walletName: name,
      strategyName: opts.strategy,
    });

    ui.start();

    // Log initial agent info
    ui.log('system', `Agent started: ${name}`);
    ui.log('info', `Strategy: ${strategy.name} — ${strategy.description}`);
    ui.log('info', `Interval: ${strategy.intervalMs / 1000}s | Max trade: ${strategy.maxTradePercent}% | Min confidence: ${(strategy.minConfidence * 100).toFixed(0)}%`);
    ui.log('info', `Mode: ${dryRun ? 'DRY RUN (no real trades)' : 'LIVE'} | Network: ${config.solanaNetwork}`);
    ui.log('info', `Wallet: ${shortenAddress(w.publicKey)}`);

    // Handle slash commands
    ui.setSubmitHandler((value: string) => {
      const cmd = value.trim().toLowerCase();
      if (cmd === '/quit' || cmd === '/exit') {
        ui.log('system', 'Shutting down...');
        stopAgent(name);
        setTimeout(() => { ui.stop(); process.exit(0); }, 500);
      } else if (cmd === '/stop') {
        stopAgent(name);
        ui.log('system', 'Agent stopped. Use /quit to exit.');
      } else if (cmd === '/status') {
        const agents = getAgentStatus();
        if (agents.length === 0) {
          ui.log('info', 'No agents running');
        } else {
          for (const a of agents) {
            ui.log('info', `${a.name}: ${a.running ? 'running' : 'stopped'} | strategy=${a.strategy} trades=${a.trades} dryRun=${a.dryRun}`);
          }
        }
      } else if (cmd === '/balance') {
        ui.setActivity('Fetching balances...');
        const connection = getConnection(config);
        getTokenBalances(connection, new PublicKey(w.publicKey)).then((balances) => {
          ui.setActivity(null);
          const lines = balances.map((b) => `${b.symbol}: ${b.uiBalance}`).join(' | ');
          ui.log('info', `Balances: ${lines}`);
        }).catch((err) => {
          ui.setActivity(null);
          ui.log('error', `Balance fetch failed: ${err.message}`);
        });
      } else if (cmd === '/strategy') {
        ui.log('info', `Current: ${opts.strategy}`);
        ui.log('info', `Available: ${Object.keys(STRATEGIES).join(', ')}`);
      } else if (cmd === '/help') {
        ui.log('info', 'Commands: /status /balance /strategy /stop /quit /help');
      } else if (cmd.startsWith('/')) {
        ui.log('warning', `Unknown command: ${cmd}. Type /help for available commands.`);
      } else {
        ui.log('user', value);
        ui.log('info', 'Free chat not supported yet. Use /help for commands.');
      }
    });

    // Handle exit
    ui.setExitHandler(() => {
      ui.log('system', 'Shutting down...');
      stopAgent(name);
      setTimeout(() => { ui.stop(); process.exit(0); }, 500);
    });

    try {
      await startAgent(config, name, keypair, opts.strategy, dryRun, ui);
    } catch (err: any) {
      ui.log('error', err.message);
    }
  });

program
  .command('status')
  .description('Show running agents')
  .action(() => {
    const agents = getAgentStatus();
    if (agents.length === 0) {
      showInfo('No agents running');
      return;
    }
    showTitle('Running Agents');
    for (const a of agents) {
      showAgent(
        a.name,
        a.running ? 'running' : 'stopped',
        `strategy=${a.strategy} trades=${a.trades} dryRun=${a.dryRun} started=${a.started.slice(11, 19)}`
      );
    }
  });

program
  .command('stop <name>')
  .description('Stop a running agent')
  .action((name: string) => {
    if (stopAgent(name)) {
      showSuccess(`Agent "${name}" stopped`);
    } else {
      showError(`Agent "${name}" is not running`);
    }
  });

// ─── config commands ────────────────────────────────────────────────

const configCmd = program.command('config').description('Configuration management');

configCmd
  .command('set <key> <value>')
  .description('Set a config value')
  .action((key: string, value: string) => {
    setConfigValue(key, value);
    const display = key.toLowerCase().includes('key') || key.toLowerCase().includes('private')
      ? value.slice(0, 6) + '...' + value.slice(-4)
      : value;
    showSuccess(`${key} = ${display}`);
  });

configCmd
  .command('show')
  .description('Show current configuration')
  .action(() => {
    showTitle('Configuration');
    showTable(showConfig());
  });

// ─── helpers ────────────────────────────────────────────────────────

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // Mute password output
    const stdout = process.stdout;
    let muted = false;
    const origWrite = stdout.write.bind(stdout);
    (rl as any)._writeToOutput = (str: string) => {
      if (muted && !str.includes('\n') && !str.includes('\r')) {
        origWrite('*');
      } else {
        origWrite(str);
      }
    };
    rl.question(prompt, (answer) => {
      muted = false;
      rl.close();
      console.log();
      resolve(answer);
    });
    muted = true;
  });
}

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

program.parseAsync(process.argv).catch((err) => {
  showError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
