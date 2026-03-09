/**
 * Full-screen terminal UI — adapted from aura-cli TerminalUI
 * Alt screen, raw mode, viewport scrolling, animated busy indicators
 */

import { emitKeypressEvents } from 'readline';
import chalk from 'chalk';

export type LogKind =
  | 'system'
  | 'info'
  | 'user'
  | 'assistant'
  | 'warning'
  | 'error'
  | 'success'
  | 'command';

interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
}

const MAX_LOG_ENTRIES = 240;

function wrapParagraph(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    let remaining = paragraph;
    while (remaining.length > width) {
      let sliceIndex = remaining.lastIndexOf(' ', width);
      if (sliceIndex <= 0) sliceIndex = width;
      result.push(remaining.slice(0, sliceIndex).trimEnd());
      remaining = remaining.slice(sliceIndex).trimStart();
    }
    result.push(remaining);
  }
  return result;
}

function trimToWidth(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function trimFromStart(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(text.length - maxLength);
  return `...${text.slice(text.length - (maxLength - 3))}`;
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return `${text}${' '.repeat(width - text.length)}`;
}

function centerText(text: string, width: number): string {
  const trimmed = trimToWidth(text, width);
  if (trimmed.length >= width) return trimmed;
  const left = Math.floor((width - trimmed.length) / 2);
  const right = width - trimmed.length - left;
  return `${' '.repeat(left)}${trimmed}${' '.repeat(right)}`;
}

function buildHeaderCardLine(content: string, width: number): string {
  return `${chalk.gray('│ ')}${padRight(content, width - 1)}${chalk.gray('│')}`;
}

function normalizeMarkdownLine(line: string): string {
  let next = line;
  if (/^\s*#{1,6}\s+/.test(next)) next = next.replace(/^(\s*)#{1,6}\s+/, '$1◦ ');
  else if (/^\s*[-*]\s+/.test(next)) next = next.replace(/^(\s*)[-*]\s+/, '$1• ');
  next = next.replace(/`([^`]+)`/g, '$1');
  next = next.replace(/\*\*([^*]+)\*\*/g, '$1');
  next = next.replace(/__([^_]+)__/g, '$1');
  next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return next;
}

function normalizeMarkdownForTerminal(kind: LogKind, text: string): string {
  if (kind === 'user' || kind === 'command') return text;
  return text.split('\n').map(normalizeMarkdownLine).join('\n');
}

function getPrefix(kind: LogKind): { plain: string; display: string } {
  switch (kind) {
    case 'info':     return { plain: '· ', display: chalk.hex('#cbd5e1')('· ') };
    case 'user':     return { plain: '◉ ', display: chalk.cyanBright('◉ ') };
    case 'assistant': return { plain: '✦ ', display: chalk.magentaBright('✦ ') };
    case 'warning':  return { plain: '▲ ', display: chalk.yellowBright('▲ ') };
    case 'error':    return { plain: '✕ ', display: chalk.redBright('✕ ') };
    case 'success':  return { plain: '● ', display: chalk.greenBright('● ') };
    case 'command':  return { plain: '◌ ', display: chalk.magenta('◌ ') };
    case 'system':   return { plain: '· ', display: chalk.gray('· ') };
    default:         return { plain: '• ', display: chalk.dim('• ') };
  }
}

function colorize(kind: LogKind, text: string): string {
  switch (kind) {
    case 'info':      return chalk.hex('#cbd5e1')(text);
    case 'user':      return chalk.cyan(text);
    case 'assistant': return chalk.white(text);
    case 'warning':   return chalk.yellow(text);
    case 'error':     return chalk.red(text);
    case 'success':   return chalk.green(text);
    case 'command':   return chalk.magenta(text);
    case 'system':    return chalk.gray(text);
    default:          return chalk.dim(text);
  }
}

function shouldInsertSpacer(current: LogEntry, next: LogEntry | undefined): boolean {
  if (!next) return false;
  if (current.kind === 'success' && next.kind === 'success') return false;
  if (current.kind === 'command' && next.kind === 'command') return false;
  return true;
}

export class TerminalUI {
  private model: string;
  private walletName: string;
  private strategyName: string;
  private status = 'Ready';
  private activity: string | null = null;
  private activityPreview = '';
  private busy = false;
  private busyFrame = 0;
  private animationTick = 0;
  private input = '';
  private viewportTop: number | null = null;
  private lastBodyHeight = 0;
  private lastMessageLineCount = 0;
  private logEntries: LogEntry[] = [];
  private nextEntryId = 1;
  private submitHandler: ((value: string) => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private confirmResolver: ((answer: boolean) => void) | null = null;
  private confirmQuestion: string | null = null;
  private isStarted = false;
  private cleanedUp = false;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly keypressHandler: (str: string, key: any) => void;
  private readonly resizeHandler: () => void;

  constructor(options: { model: string; walletName: string; strategyName: string }) {
    this.model = options.model;
    this.walletName = options.walletName;
    this.strategyName = options.strategyName;
    this.keypressHandler = (str, key) => this.handleKeypress(str, key);
    this.resizeHandler = () => this.render();
  }

  setSubmitHandler(handler: (value: string) => void): void {
    this.submitHandler = handler;
  }

  setExitHandler(handler: () => void): void {
    this.exitHandler = handler;
  }

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    this.cleanedUp = false;
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.keypressHandler);
    process.stdout.on('resize', this.resizeHandler);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    this.animationTimer = setInterval(() => this.animateIdleState(), 420);
    this.render();
  }

  stop(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    process.stdin.off('keypress', this.keypressHandler);
    process.stdout.off('resize', this.resizeHandler);
    if (this.animationTimer) { clearInterval(this.animationTimer); this.animationTimer = null; }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
  }

  setBusy(busy: boolean, status?: string): void {
    this.busy = busy;
    if (!busy) this.busyFrame = 0;
    if (status) this.status = status;
    else if (!busy && this.status.startsWith('Working')) this.status = 'Ready';
    this.render();
  }

  setStatus(status: string): void {
    this.status = status;
    this.render();
  }

  setActivity(activity: string | null, preview = ''): void {
    this.activity = activity;
    this.activityPreview = activity ? preview : '';
    if (activity) this.busyFrame = (this.busyFrame + 1) % 10_000;
    this.render();
  }

  setModel(model: string): void {
    this.model = model;
    this.render();
  }

  clearConversation(): void {
    this.logEntries = [];
    this.viewportTop = null;
    this.render();
  }

  log(kind: LogKind, text: string): void {
    this.logEntries.push({ id: this.nextEntryId++, kind, text: text.replace(/\r\n/g, '\n') });
    if (this.logEntries.length > MAX_LOG_ENTRIES) {
      this.logEntries = this.logEntries.slice(this.logEntries.length - MAX_LOG_ENTRIES);
    }
    this.render();
  }

  createEntry(kind: LogKind, text = ''): number {
    const entry: LogEntry = { id: this.nextEntryId++, kind, text };
    this.logEntries.push(entry);
    if (this.logEntries.length > MAX_LOG_ENTRIES) {
      this.logEntries = this.logEntries.slice(this.logEntries.length - MAX_LOG_ENTRIES);
    }
    this.render();
    return entry.id;
  }

  appendToEntry(entryId: number, text: string): void {
    const entry = this.logEntries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.text += text;
    this.render();
  }

  updateEntry(entryId: number, text: string): void {
    const entry = this.logEntries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.text = text;
    this.render();
  }

  removeEntry(entryId: number): void {
    const next = this.logEntries.filter((e) => e.id !== entryId);
    if (next.length === this.logEntries.length) return;
    this.logEntries = next;
    this.render();
  }

  async confirm(question: string): Promise<boolean> {
    if (this.confirmResolver) return false;
    this.confirmQuestion = question;
    this.render();
    return new Promise<boolean>((resolve) => { this.confirmResolver = resolve; });
  }

  private handleKeypress(str: string, key: any): void {
    if (this.confirmResolver) {
      if (key?.name === 'return') {
        const resolve = this.confirmResolver;
        this.confirmResolver = null; this.confirmQuestion = null;
        resolve(true); this.render(); return;
      }
      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        const resolve = this.confirmResolver;
        this.confirmResolver = null; this.confirmQuestion = null;
        resolve(false); this.render(); return;
      }
      return;
    }

    if (key?.ctrl && key?.name === 'c') { this.exitHandler?.(); return; }

    if (key?.name === 'return') {
      const submittedValue = this.input.trim();
      this.input = '';
      this.render();
      if (submittedValue) this.submitHandler?.(submittedValue);
      return;
    }

    if (key?.name === 'backspace') { this.input = this.input.slice(0, -1); this.render(); return; }
    if (key?.name === 'up') { this.scrollBy(-1); return; }
    if (key?.name === 'down') { this.scrollBy(1); return; }
    if (key?.name === 'pageup') { this.scrollBy(-Math.max(3, Math.floor(this.lastBodyHeight / 2))); return; }
    if (key?.name === 'pagedown') { this.scrollBy(Math.max(3, Math.floor(this.lastBodyHeight / 2))); return; }
    if (key?.name === 'home') { this.jumpToOldest(); return; }
    if (key?.name === 'end') { this.jumpToLatest(); return; }
    if (key?.name === 'escape') { this.input = ''; this.render(); return; }
    if (key?.ctrl && key?.name === 'l') { this.render(); return; }

    if (typeof str === 'string' && str && !key?.meta && !key?.ctrl) {
      this.input += str;
      this.render();
    }
  }

  private formatEntry(entry: LogEntry, width: number): string[] {
    const normalizedText = normalizeMarkdownForTerminal(entry.kind, entry.text);
    const prefix = getPrefix(entry.kind);
    const continuationPrefix = ' '.repeat(prefix.plain.length);
    const availableWidth = Math.max(8, width - prefix.plain.length);
    const paragraphs = wrapParagraph(normalizedText, availableWidth);
    return paragraphs.map((paragraph, index) => {
      const bodyText = colorize(entry.kind, paragraph);
      return index === 0 ? `${prefix.display}${bodyText}` : `${continuationPrefix}${bodyText}`;
    });
  }

  private animateIdleState(): void {
    if (!this.isStarted || this.cleanedUp) return;
    if (this.busy || this.confirmResolver || this.logEntries.length > 0) return;
    this.animationTick = (this.animationTick + 1) % 6;
    this.render();
  }

  private getMaxViewportTop(): number {
    return Math.max(0, this.lastMessageLineCount - this.lastBodyHeight);
  }

  private scrollBy(delta: number): void {
    if (this.lastMessageLineCount === 0) return;
    const maxTop = this.getMaxViewportTop();
    if (maxTop === 0) return;
    const currentTop = this.viewportTop === null ? maxTop : this.viewportTop;
    const nextTop = Math.max(0, Math.min(maxTop, currentTop + delta));
    this.viewportTop = nextTop >= maxTop ? null : nextTop;
    this.render();
  }

  private jumpToOldest(): void {
    if (this.lastMessageLineCount === 0) return;
    const maxTop = this.getMaxViewportTop();
    if (maxTop === 0) return;
    this.viewportTop = 0;
    this.render();
  }

  private jumpToLatest(): void {
    if (this.lastMessageLineCount === 0) return;
    this.viewportTop = null;
    this.render();
  }

  private buildEmptyState(width: number, maxLines: number): string[] {
    const cardWidth = Math.max(48, Math.min(width, 92));
    const cardInnerWidth = cardWidth - 2;
    const leftPad = ' '.repeat(Math.max(0, Math.floor((width - cardWidth) / 2)));
    const border = chalk.cyanBright;
    const pulseFrames = ['#00d4ff', '#33ddff', '#66e5ff', '#33ddff', '#00d4ff', '#00bbee'];
    const pulseColor = pulseFrames[this.animationTick % pulseFrames.length];
    const labelColor = chalk.hex(pulseColor);
    const glyphColor = chalk.hex(pulseColor);

    const frameTop = `${leftPad}${border(`╭${'─'.repeat(cardInnerWidth)}╮`)}`;
    const frameBottom = `${leftPad}${border(`╰${'─'.repeat(cardInnerWidth)}╯`)}`;
    const row = (content: string, color = chalk.white): string =>
      `${leftPad}${border('│')}${color(padRight(content, cardInnerWidth))}${border('│')}`;

    const lines = [
      frameTop,
      row(centerText(`solana agent ${'•'.repeat((this.animationTick % 3) + 1)}`, cardInnerWidth), labelColor),
      row(' '.repeat(cardInnerWidth), chalk.reset),
      row(centerText(this.animationTick % 2 === 0 ? '◇ ◆ ◇' : '◆ ◇ ◆', cardInnerWidth), glyphColor),
      row(centerText(this.animationTick % 2 === 0 ? '◆ ◇ ◆' : '◇ ◆ ◇', cardInnerWidth), glyphColor),
      row(centerText('autonomous trading powered by groq', cardInnerWidth), chalk.whiteBright),
      row(centerText(`${this.model.toLowerCase()} • ${this.walletName} • ${this.strategyName}`, cardInnerWidth), chalk.gray),
      frameBottom,
    ];

    return lines.slice(0, Math.max(0, maxLines));
  }

  private buildBusyIndicator(width: number, maxLines: number): string[] {
    if (maxLines <= 0) return [];
    const lineCount = Math.min(Math.max(2, Math.min(4, maxLines)), 4);
    const lineWidths = [Math.floor(width * 0.58), Math.floor(width * 0.82), Math.floor(width * 0.68), Math.floor(width * 0.9)];
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      const laneWidth = Math.max(16, Math.min(width, lineWidths[index] || width));
      const leftPad = ' '.repeat(Math.max(0, Math.floor((width - laneWidth) / 2)));
      const rightPad = ' '.repeat(Math.max(0, width - laneWidth - leftPad.length));
      const segmentWidth = Math.max(6, Math.min(16, Math.floor(laneWidth * 0.18)));
      const cycle = laneWidth + segmentWidth + 6;
      const frame = (this.busyFrame + index * 3) % cycle;
      const start = Math.max(0, Math.min(laneWidth - segmentWidth, frame - segmentWidth));
      const end = Math.min(laneWidth, start + segmentWidth);
      const before = ' '.repeat(start);
      const active = ' '.repeat(Math.max(0, end - start));
      const after = ' '.repeat(Math.max(0, laneWidth - end));
      const line =
        leftPad +
        chalk.bgHex('#0e1119')(
          `${before}${chalk.bgHex(index % 2 === 0 ? '#1a2336' : '#161f16').hex(index % 2 === 0 ? '#7dd3fc' : '#86efac')(active)}${after}`
        ) +
        rightPad;
      lines.push(line);
    }
    return lines;
  }

  private buildBusyPreview(width: number, maxLines: number): string[] {
    if (maxLines <= 0) return [];
    const normalizedLines = this.activityPreview
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => normalizeMarkdownLine(line).trim())
      .filter(Boolean);
    if (normalizedLines.length === 0) return this.buildBusyIndicator(width, maxLines);
    const tail = normalizedLines.slice(-Math.max(2, Math.min(maxLines, 4)));
    const rendered: string[] = [];
    for (let index = 0; index < tail.length; index += 1) {
      const line = tail[index];
      const wrapped = wrapParagraph(trimToWidth(line, width), width);
      for (const chunk of wrapped) {
        const padded = padRight(chunk, width);
        if (index === tail.length - 1) rendered.push(chalk.bgHex('#101922').hex('#7dd3fc')(padded));
        else if (index === tail.length - 2) rendered.push(chalk.bgHex('#0f1612').hex('#86efac')(padded));
        else rendered.push(chalk.bgBlackBright.gray(padded));
      }
    }
    return rendered.slice(-maxLines);
  }

  private render(): void {
    if (!this.isStarted || this.cleanedUp) return;

    const columns = Math.max(72, process.stdout.columns || 72);
    const rows = Math.max(20, process.stdout.rows || 24);
    const innerWidth = columns - 2;

    const headerCardWidth = Math.max(24, innerWidth - 2);
    const derivedStatus = this.confirmResolver
      ? 'Confirm'
      : this.status || (this.busy ? 'Live' : 'Ready');
    const statusLabel = trimToWidth(derivedStatus, Math.max(12, Math.floor(headerCardWidth / 3)));
    const statusColor = this.confirmResolver
      ? chalk.yellowBright
      : this.busy
        ? chalk.yellowBright
        : chalk.greenBright;
    const headerTopBorder = chalk.gray(`╭${'─'.repeat(headerCardWidth)}╮`);
    const headerBottomBorder = chalk.gray(`╰${'─'.repeat(headerCardWidth)}╯`);

    const headerLines = [
      headerTopBorder,
      buildHeaderCardLine(
        `${chalk.cyanBright.bold('SOLANA')} ${chalk.whiteBright('AGENT')} ${chalk.gray('•')} ${chalk.magenta('powered by groq')}`,
        headerCardWidth
      ),
      buildHeaderCardLine(`${chalk.dim('STATUS')} ${statusColor(statusLabel)}`, headerCardWidth),
      headerBottomBorder,
    ];

    const activityLines = this.activity
      ? [chalk.dim(`· ${trimToWidth(this.activity, innerWidth - 2)}`)]
      : [];

    const footerWidth = Math.max(24, innerWidth);
    const footerDivider = chalk.gray('─'.repeat(Math.max(10, footerWidth)));
    const footerLines = this.confirmResolver
      ? [
          footerDivider,
          chalk.hex('#86efac')(padRight(trimToWidth('· action pending • confirm', footerWidth), footerWidth)),
          chalk.bgHex('#b7f5c6').black(padRight(trimToWidth(' ↵ confirm', footerWidth), footerWidth)),
          chalk.gray(padRight(trimToWidth(`${this.confirmQuestion || ''} • esc cancels`, footerWidth), footerWidth)),
        ]
      : (() => {
          const inputText = this.input
            ? trimToWidth(this.input, footerWidth - 3)
            : 'enter a command or chat with the agent...';
          const prefix = this.busy
            ? chalk.bgBlack.yellow(' … ')
            : chalk.bgBlack.cyan(' › ');
          const textLine = this.input
            ? chalk.bgBlack.white(padRight(inputText, footerWidth - 3))
            : chalk.bgBlack.gray(padRight(inputText, footerWidth - 3));
          const emptyLine = chalk.bgBlack(' '.repeat(footerWidth));
          const contextLine = chalk.dim(
            trimFromStart(`${this.model.toLowerCase()}  •  ${this.walletName}  •  ${this.strategyName}`, footerWidth)
          );
          return [footerDivider, emptyLine, `${prefix}${textLine}`, emptyLine, contextLine];
        })();

    const bodyHeight = Math.max(6, rows - headerLines.length - activityLines.length - footerLines.length);
    const baseMessageLines = this.logEntries.flatMap((entry, index) => {
      const lines = this.formatEntry(entry, innerWidth);
      if (shouldInsertSpacer(entry, this.logEntries[index + 1])) lines.push('');
      return lines;
    });
    const busyPreview =
      this.busy && this.activity
        ? this.buildBusyPreview(innerWidth, Math.min(4, Math.max(2, bodyHeight - Math.min(baseMessageLines.length, bodyHeight))))
        : [];
    const messageLines = busyPreview.length > 0 ? [...baseMessageLines, ...busyPreview] : baseMessageLines;
    this.lastBodyHeight = bodyHeight;
    this.lastMessageLineCount = messageLines.length;

    let visibleMessageLines: string[];
    if (messageLines.length === 0) {
      this.viewportTop = null;
      visibleMessageLines = this.buildEmptyState(innerWidth, bodyHeight);
    } else {
      const maxTop = Math.max(0, messageLines.length - bodyHeight);
      const top = this.viewportTop === null ? maxTop : Math.max(0, Math.min(maxTop, this.viewportTop));
      this.viewportTop = top >= maxTop ? null : top;
      visibleMessageLines = messageLines.slice(top, top + bodyHeight);
    }

    const screen = [...headerLines, ...activityLines, ...visibleMessageLines, ...footerLines].join('\n');
    process.stdout.write(`\x1b[2J\x1b[H${screen}`);
  }
}

/* ── Standalone helpers for non-TUI commands ─────────────────────── */

export function showTitle(text: string): void {
  console.log(chalk.bold.cyan(`\n  ${text}\n`));
}

export function showSuccess(text: string): void {
  console.log(chalk.green(`  ${text}`));
}

export function showError(text: string): void {
  console.log(chalk.red(`  ${text}`));
}

export function showWarning(text: string): void {
  console.log(chalk.yellow(`  ${text}`));
}

export function showInfo(text: string): void {
  console.log(chalk.gray(`  ${text}`));
}

export function showKeyValue(key: string, value: string): void {
  console.log(`  ${chalk.gray(key + ':')} ${value}`);
}

export function showTable(rows: Record<string, string>): void {
  const maxKey = Math.max(...Object.keys(rows).map((k) => k.length));
  for (const [key, value] of Object.entries(rows)) {
    console.log(`  ${chalk.gray(key.padEnd(maxKey))}  ${value}`);
  }
}

export function showDivider(): void {
  console.log(chalk.gray('  ' + '-'.repeat(50)));
}

export function showAgent(name: string, status: string, detail: string): void {
  const statusColor = status === 'running' ? chalk.green : chalk.gray;
  console.log(`  ${chalk.bold(name)}  ${statusColor(status)}  ${chalk.gray(detail)}`);
}

export function showTrade(result: { action: string; fromToken: string; toToken: string; dryRun: boolean; success: boolean; amountIn: string; amountOut?: string; error?: string }): void {
  const prefix = result.dryRun ? chalk.yellow('[DRY RUN]') : '';
  if (result.success) {
    console.log(`  ${prefix} ${chalk.green(result.action.toUpperCase())} ${result.amountIn} ${result.fromToken} -> ${result.amountOut || '?'} ${result.toToken}`);
  } else {
    console.log(`  ${prefix} ${chalk.red('FAILED')} ${result.action} ${result.fromToken} -> ${result.toToken}: ${result.error}`);
  }
}

export function showDecision(decision: { action: string; confidence: number; reasoning: string }): void {
  const color = decision.action === 'hold' ? chalk.gray : decision.action === 'buy' ? chalk.green : chalk.red;
  console.log(`  ${color(decision.action.toUpperCase())} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`);
  console.log(`  ${chalk.gray(decision.reasoning)}`);
}
