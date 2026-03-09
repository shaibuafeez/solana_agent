/**
 * Multi-agent orchestrator — start/stop/status for autonomous trading loops
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import type { AppConfig, AgentState, TradeResult, MarketData } from './types.js';
import { getConnection, getTokenBalances, getSolBalance, resolveToken, solToLamports } from './solana.js';
import { executeSwap } from './jupiter.js';
import { getStrategy, getAIDecision } from './strategy.js';
import { Logger } from './logger.js';
import type { TerminalUI } from './ui.js';
import { showDecision, showTrade, showInfo, showWarning, showError } from './ui.js';

const runningAgents = new Map<string, AgentState>();

export function getRunningAgents(): Map<string, AgentState> {
  return runningAgents;
}

export async function startAgent(
  config: AppConfig,
  walletName: string,
  keypair: Keypair,
  strategyName: string,
  dryRun: boolean,
  ui?: TerminalUI
): Promise<void> {
  if (runningAgents.has(walletName)) {
    throw new Error(`Agent "${walletName}" is already running`);
  }

  const strategy = getStrategy(strategyName);
  const abortController = new AbortController();
  const logger = new Logger(config.logsDir, walletName);

  const state: AgentState = {
    walletName,
    strategy: strategyName,
    running: true,
    abortController,
    startedAt: new Date().toISOString(),
    tradesExecuted: 0,
    lastDecision: null,
    dryRun,
  };

  runningAgents.set(walletName, state);
  logger.info(`Agent started: strategy=${strategyName} dryRun=${dryRun}`);
  logger.info(`Wallet: ${keypair.publicKey.toBase58()}`);
  logger.info(`Interval: ${strategy.intervalMs / 1000}s`);

  // Start the loop (non-blocking)
  agentLoop(config, state, keypair, logger, ui).catch((err) => {
    logger.error(`Agent crashed: ${err.message}`);
    if (ui) ui.log('error', `Agent "${walletName}" crashed: ${err.message}`);
    else showError(`Agent "${walletName}" crashed: ${err.message}`);
    state.running = false;
    runningAgents.delete(walletName);
    logger.close();
  });
}

async function agentLoop(
  config: AppConfig,
  state: AgentState,
  keypair: Keypair,
  logger: Logger,
  ui?: TerminalUI
): Promise<void> {
  const strategy = getStrategy(state.strategy);
  const connection = getConnection(config);
  const signal = state.abortController.signal;

  while (!signal.aborted) {
    try {
      // 1. Gather market data
      if (ui) ui.setActivity('Fetching balances...');
      const balances = await getTokenBalances(connection, keypair.publicKey);
      const marketData: MarketData = {
        solBalance: balances.find((b) => b.symbol === 'SOL')?.balance || 0,
        tokenBalances: balances,
        timestamp: Date.now(),
      };

      const balanceStr = balances.map((b) => `${b.symbol}=${b.uiBalance}`).join(', ');
      logger.info(`Balances: ${balanceStr}`);
      if (ui) ui.log('info', `Balances: ${balanceStr}`);

      // 2. Get AI decision
      let decision;
      try {
        if (ui) {
          ui.setBusy(true, 'Thinking');
          ui.setActivity('Querying Grok for trading decision...');
        }
        decision = await getAIDecision(config, strategy, marketData);
        state.lastDecision = decision;
        logger.ai(`Decision: ${JSON.stringify(decision)}`);
        if (ui) {
          ui.setBusy(false);
          ui.setActivity(null);
          const color = decision.action === 'hold' ? 'info' : decision.action === 'buy' ? 'success' : 'warning';
          ui.log(color, `${decision.action.toUpperCase()} (confidence: ${(decision.confidence * 100).toFixed(0)}%) — ${decision.reasoning}`);
        } else {
          showDecision(decision);
        }
      } catch (err: any) {
        logger.error(`AI decision failed: ${err.message}`);
        if (ui) {
          ui.setBusy(false);
          ui.setActivity(null);
          ui.log('warning', `AI decision failed: ${err.message}`);
        } else {
          showWarning(`AI decision failed: ${err.message}`);
        }
        await sleep(strategy.intervalMs, signal);
        continue;
      }

      // 3. Execute trade if warranted
      if (decision.action !== 'hold' && decision.confidence >= strategy.minConfidence) {
        if (ui) ui.setActivity(`Executing ${decision.action}...`);
        const result = await executeTrade(config, connection, keypair, decision, marketData, state.dryRun, logger);
        if (result.success) state.tradesExecuted++;
        if (ui) {
          ui.setActivity(null);
          const prefix = result.dryRun ? '[DRY RUN] ' : '';
          if (result.success) {
            ui.log('success', `${prefix}${result.action.toUpperCase()} ${result.amountIn} ${result.fromToken} -> ${result.amountOut || '?'} ${result.toToken}`);
          } else {
            ui.log('error', `${prefix}FAILED ${result.action} ${result.fromToken} -> ${result.toToken}: ${result.error}`);
          }
        } else {
          showTrade(result);
        }
      } else if (decision.action === 'hold') {
        if (ui) ui.log('info', `Holding — confidence ${(decision.confidence * 100).toFixed(0)}%`);
        else showInfo(`Holding — confidence ${(decision.confidence * 100).toFixed(0)}%`);
      } else {
        const msg = `Skipping — confidence ${(decision.confidence * 100).toFixed(0)}% < min ${(strategy.minConfidence * 100).toFixed(0)}%`;
        if (ui) ui.log('info', msg);
        else showInfo(msg);
      }
    } catch (err: any) {
      logger.error(`Loop error: ${err.message}`);
      if (ui) ui.log('warning', `Agent loop error: ${err.message}`);
      else showWarning(`Agent loop error: ${err.message}`);
    }

    // 4. Sleep until next cycle
    if (ui) {
      ui.setActivity(null);
      ui.setStatus(`Next cycle in ${strategy.intervalMs / 1000}s`);
    }
    await sleep(strategy.intervalMs, signal);
    if (ui) ui.setStatus('Ready');
  }

  state.running = false;
  runningAgents.delete(state.walletName);
  logger.info('Agent stopped');
  logger.close();
}

async function executeTrade(
  config: AppConfig,
  connection: import('@solana/web3.js').Connection,
  keypair: Keypair,
  decision: import('./types.js').AIDecision,
  marketData: MarketData,
  dryRun: boolean,
  logger: Logger
): Promise<TradeResult> {
  const fromToken = resolveToken(decision.fromToken);
  const toToken = resolveToken(decision.toToken);

  if (!fromToken || !toToken) {
    const err = `Unknown token: ${!fromToken ? decision.fromToken : decision.toToken}`;
    logger.error(err);
    return { success: false, action: decision.action, fromToken: decision.fromToken, toToken: decision.toToken, amountIn: '0', error: err, dryRun };
  }

  // Calculate amount
  const tokenBalance = marketData.tokenBalances.find((b) => b.symbol === fromToken.symbol);
  if (!tokenBalance || tokenBalance.balance <= 0) {
    const err = `No ${fromToken.symbol} balance to trade`;
    logger.error(err);
    return { success: false, action: decision.action, fromToken: decision.fromToken, toToken: decision.toToken, amountIn: '0', error: err, dryRun };
  }

  const tradeAmount = tokenBalance.balance * (decision.amountPercent / 100);
  const amountLamports = Math.floor(tradeAmount * Math.pow(10, fromToken.decimals));

  // Keep minimum SOL for fees
  if (fromToken.symbol === 'SOL') {
    const minKeep = 0.01;
    if (tokenBalance.balance - tradeAmount < minKeep) {
      const err = `Would leave less than ${minKeep} SOL for fees`;
      logger.error(err);
      return { success: false, action: decision.action, fromToken: decision.fromToken, toToken: decision.toToken, amountIn: tradeAmount.toFixed(4), error: err, dryRun };
    }
  }

  try {
    logger.trade(`Executing: ${decision.action} ${tradeAmount.toFixed(4)} ${fromToken.symbol} -> ${toToken.symbol} (dryRun=${dryRun})`);

    const { quote, txSignature } = await executeSwap(
      config,
      connection,
      keypair,
      fromToken.mint,
      toToken.mint,
      amountLamports,
      dryRun
    );

    const outAmount = (Number(quote.outAmount) / Math.pow(10, toToken.decimals)).toFixed(4);
    logger.trade(`Result: ${tradeAmount.toFixed(4)} ${fromToken.symbol} -> ${outAmount} ${toToken.symbol} tx=${txSignature || 'dry-run'}`);

    return {
      success: true,
      action: decision.action,
      fromToken: fromToken.symbol,
      toToken: toToken.symbol,
      amountIn: tradeAmount.toFixed(4),
      amountOut: outAmount,
      txSignature: txSignature || undefined,
      dryRun,
    };
  } catch (err: any) {
    logger.error(`Trade failed: ${err.message}`);
    return {
      success: false,
      action: decision.action,
      fromToken: fromToken.symbol,
      toToken: toToken.symbol,
      amountIn: tradeAmount.toFixed(4),
      error: err.message,
      dryRun,
    };
  }
}

export function stopAgent(walletName: string): boolean {
  const agent = runningAgents.get(walletName);
  if (!agent) return false;
  agent.abortController.abort();
  return true;
}

export function getAgentStatus(): { name: string; strategy: string; running: boolean; trades: number; started: string; dryRun: boolean }[] {
  return Array.from(runningAgents.values()).map((a) => ({
    name: a.walletName,
    strategy: a.strategy,
    running: a.running,
    trades: a.tradesExecuted,
    started: a.startedAt,
    dryRun: a.dryRun,
  }));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
