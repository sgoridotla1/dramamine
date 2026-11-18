/** Text renderings that agents read: the recording log and the replay report. */
import { renderLocatorWithMarkers } from './render-locator';
import type {
  Checkpoint,
  ConsoleEntry,
  NetworkEntry,
  Recording,
  RecordingSummary,
  Step,
  Target,
} from './recording';
import type { CheckResult } from './checks';
import type { CheckpointResult, ReplayReport, StepResult } from './report';

const ERROR_BODY_CHARS = 300;

function shortUrl(url: string, base: string): string {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.origin === b.origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

function quote(s: string, max = 200): string {
  const t = s.length > max ? `${s.slice(0, max - 3)}...` : s;
  return JSON.stringify(t);
}

function when(t: number): string {
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const PAD = '   ';
const SUB = `${PAD}         `;

function targetLines(t: Target, label: string): string[] {
  const [primary, alt] = t.locators;
  const lines = [`${label}${primary ? renderLocatorWithMarkers(primary) : '(no locator)'}   (${t.description})`];
  if (alt) lines.push(`${SUB}alt: ${renderLocatorWithMarkers(alt)}`);
  return lines;
}

function networkLine(n: NetworkEntry, base: string): string {
  const outcome = n.status !== undefined ? `${n.status}` : `failed: ${n.errorText ?? 'no response'}`;
  const ms = n.durationMs !== undefined ? ` (${n.durationMs}ms)` : '';
  let line = `${SUB}net: ${n.method} ${shortUrl(n.url, base)} -> ${outcome}${ms}`;
  if ((n.status ?? 0) >= 400 && n.responseBody?.text) {
    const body = n.responseBody.text.replace(/\s+/g, ' ').trim();
    line += `\n${SUB}     body: ${body.length > ERROR_BODY_CHARS ? `${body.slice(0, ERROR_BODY_CHARS - 3)}...` : body}`;
  }
  return line;
}

function consoleLine(c: ConsoleEntry): string {
  const label = c.level === 'warning' ? 'warn' : c.level;
  const at = c.stack?.[0] ? `  at ${c.stack[0]}` : '';
  return `${SUB}console: ${label} ${quote(c.text)}${at}`;
}

function stepHead(s: Step, base: string): string[] {
  const n = `${s.index}.`.padEnd(4);
  switch (s.kind) {
    case 'initial-load':
      return [`${n}start    ${s.url}`];
    case 'navigate':
      return [`${n}navigate ${shortUrl(s.url, base)}`];
    case 'click':
    case 'dblclick':
      return targetLines(s.target, `${n}${s.kind.padEnd(9)}`);
    case 'input': {
      const lines = targetLines(s.target, `${n}${'input'.padEnd(9)}`);
      lines.push(`${SUB}value: ${s.redacted ? `******** (redacted; pass redactedValues["${s.index}"] to replay)` : quote(s.value)}`);
      return lines;
    }
    case 'select': {
      const lines = targetLines(s.target, `${n}${'select'.padEnd(9)}`);
      lines.push(`${SUB}option: ${quote(s.label)} (value ${quote(s.value)})`);
      return lines;
    }
    case 'key':
      return targetLines(s.target, `${n}${`key ${s.key}`.padEnd(9)} on `);
  }
}

function checkpointBlock(c: Checkpoint): string[] {
  const lines = [`${PAD}CP#${c.id} (checkpoint after step ${c.afterStep})${c.contextOnly ? '  [context only]' : ''}`];
  const [primary, alt] = c.target.locators;
  lines.push(`${PAD}   target:   ${primary ? renderLocatorWithMarkers(primary) : '(none)'}   (${c.target.description})`);
  if (alt) lines.push(`${PAD}             alt: ${renderLocatorWithMarkers(alt)}`);
  lines.push(`${PAD}   actual:   ${quote(c.actual.text)}${c.actual.value !== undefined ? ` (value ${quote(c.actual.value)})` : ''}`);
  if (c.expected) lines.push(`${PAD}   expected: ${quote(c.expected, 1000)}   <- the user's words`);
  lines.push(`${PAD}   html:     ${c.actual.html.length > 160 ? `${c.actual.html.slice(0, 157)}...` : c.actual.html}`);
  lines.push(`${PAD}   images:   "CP#${c.id} region" and "CP#${c.id} viewport" attached below`);
  return lines;
}

/** The steps-to-reproduce log an agent reads. */
export function renderRecordingLog(r: Recording): string {
  const out: string[] = [];
  const steps = r.steps.filter((s) => s.kind !== 'initial-load').length;
  out.push(`# STR: ${r.title}`);
  out.push(`id: ${r.id}   start: ${r.startUrl}`);
  out.push(`recorded: ${when(r.startedAt)}${r.endedAt ? ` (${seconds(r.endedAt - r.startedAt)})` : ''}   viewport: ${r.viewport.width}x${r.viewport.height} @${r.viewport.deviceScaleFactor}x   browser: ${r.browserVersion}`);
  out.push(`steps: ${steps}   checkpoints: ${r.checkpoints.length}   redacted values: ${r.redactions}`);
  if (r.interrupted) out.push(`INTERRUPTED: ${r.interrupted.reason}. Steps after this point were not recorded.`);
  out.push('');
  for (const s of r.steps) {
    out.push(...stepHead(s, r.startUrl));
    if ('navigation' in s && s.navigation) out.push(`${SUB}nav: -> ${shortUrl(s.navigation, r.startUrl)}`);
    for (const n of r.network.filter((x) => x.step === s.index)) out.push(networkLine(n, r.startUrl));
    for (const c of r.console.filter((x) => x.step === s.index)) out.push(consoleLine(c));
    for (const n of r.notes.filter((x) => x.afterStep === s.index)) out.push(`${SUB}note: ${n.text}`);
    for (const c of r.checkpoints.filter((x) => x.afterStep === s.index)) out.push('', ...checkpointBlock(c), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function renderRecordingList(list: RecordingSummary[]): string {
  if (!list.length) return 'No recordings are shared with this session.';
  return list
    .map((r) => `- ${r.id}: ${quote(r.title)}  ${r.startUrl}  (${r.stepCount} steps, ${r.checkpointCount} checkpoints, ${when(r.createdAt)}${r.interrupted ? ', interrupted' : ''})`)
    .join('\n');
}

const VERDICT_TEXT: Record<ReplayReport['verdict'], string> = {
  red: 'RED - at least one check failed: the bug reproduces (or the check does not match the fixed behaviour).',
  green: 'GREEN - every evaluated check passed.',
  error: 'ERROR - a step could not be performed or a checked element was not found, so this replay says nothing about the bug.',
  unchecked: 'UNCHECKED - no deterministic checks were evaluated (none were given, or only judge checks).',
};

function checkLine(r: CheckResult): string {
  const c = r.check;
  const status = { pass: 'PASS', fail: 'FAIL', 'not-found': 'MISS', judged: 'JUDGE', 'not-evaluated': 'SKIP' }[r.status];
  let desc: string = c.op;
  if ('value' in c && c.value !== undefined) desc += ` ${quote(String(c.value))}`;
  if ('target' in c && c.target) desc += ` on ${renderLocatorWithMarkers(c.target)}`;
  if ('urlPattern' in c && c.urlPattern) desc += ` (urls containing ${quote(c.urlPattern)})`;
  const actual = r.actual !== undefined ? ` -> actual ${quote(r.actual)}` : '';
  const detail = r.detail ? `  (${r.detail})` : r.status === 'judged' ? '  (compare the screenshots below)' : '';
  return `      ${status.padEnd(5)} ${desc}${actual}${detail}`;
}

function stepResultLine(s: StepResult): string[] {
  const n = `${s.index}.`.padEnd(4);
  if (s.status === 'skipped') return [`   ${n}${s.kind.padEnd(9)} skipped`];
  if (s.status === 'failed') {
    const lines = [`   ${n}${s.kind.padEnd(9)} FAILED: ${s.error}`];
    if (s.tried?.length) lines.push(`        tried: ${s.tried.join('  |  ')}`);
    return lines;
  }
  const via = s.match ? `  via ${renderLocatorWithMarkers(s.match.locator)}${s.match.fallback ? `  [fallback: candidate ${s.match.candidate + 1}]` : ''}` : '';
  return [`   ${n}${s.kind.padEnd(9)} ok${via}`];
}

function checkpointResultLines(c: CheckpointResult): string[] {
  const lines = [`   CP#${c.checkpoint}${c.reached ? '' : '  NOT REACHED'}`];
  lines.push(`      recorded: ${quote(c.recorded.text)}`);
  if (c.replayed) lines.push(`      replayed: ${quote(c.replayed.text)}${c.replayed.value !== undefined ? ` (value ${quote(c.replayed.value)})` : ''}${c.replayed.visible ? '' : '  [not visible]'}`);
  if (c.error) lines.push(`      ${c.error}`);
  if (c.match?.fallback) lines.push(`      target found by fallback candidate ${c.match.candidate + 1}: ${renderLocatorWithMarkers(c.match.locator)}`);
  if (c.expected) lines.push(`      expected (user): ${quote(c.expected, 1000)}`);
  lines.push(...(c.checks.length ? c.checks.map(checkLine) : ['      (no checks)']));
  return lines;
}

/** The replay report an agent reads. */
export function renderReplayReport(r: ReplayReport): string {
  const out: string[] = [];
  out.push(`# Replay: ${r.title}  [${r.verdict.toUpperCase()}]`);
  out.push(VERDICT_TEXT[r.verdict]);
  out.push(`recording: ${r.recordingId}   start: ${r.startUrl}   duration: ${seconds(r.durationMs)}`);
  if (r.warnings.length) {
    out.push('', 'warnings:');
    for (const w of r.warnings) out.push(`   - ${w}`);
  }
  out.push('', 'steps:');
  for (const s of r.steps) out.push(...stepResultLine(s));
  if (r.checkpoints.length) {
    out.push('', 'checkpoints:');
    for (const c of r.checkpoints) out.push(...checkpointResultLines(c));
  }
  if (r.globalChecks.length) {
    out.push('', 'global checks:');
    for (const g of r.globalChecks) out.push(checkLine(g));
  }
  if (r.console.length) {
    out.push('', 'errors during replay:');
    for (const c of r.console.slice(0, 10)) out.push(`   step ${c.step}: ${c.level} ${quote(c.text)}`);
  }
  if (r.network.length) {
    out.push('', 'failed requests during replay:');
    for (const n of r.network.slice(0, 10)) out.push(`   step ${n.step}: ${n.method} ${shortUrl(n.url, r.startUrl)} -> ${n.status ?? n.errorText}`);
  }
  return out.join('\n');
}

