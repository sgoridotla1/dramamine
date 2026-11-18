import { renderRecordingLog, renderReplayReport, type Images, type Recording, type ReplayImageMode, type ReplayReport } from '@str/shared';

export { renderRecordingList, renderRecordingLog, renderReplayReport } from '@str/shared';

/** MCP tool result content. */
export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };

export function recordingContent(r: Recording, images: Images): Content[] {
  const content: Content[] = [{ type: 'text', text: renderRecordingLog(r) }];
  for (const c of r.checkpoints) {
    for (const [kind, id] of [['region', c.screenshots.region], ['viewport', c.screenshots.viewport]] as const) {
      const data = images[id];
      if (!data) continue;
      content.push({ type: 'text', text: `CP#${c.id} ${kind}` }, { type: 'image', data, mimeType: 'image/png' });
    }
  }
  return content;
}

/** Whether a checkpoint's replayed screenshots help the agent: something failed, needs judging, or nothing was checked. */
function worthShowing(c: ReplayReport['checkpoints'][number]): boolean {
  return !c.checks.length || c.checks.some((x) => x.status === 'fail' || x.status === 'not-found' || x.status === 'judged');
}

/**
 * failed (default): replayed region and viewport only for checkpoints worth looking at; the agent
 * already has the recorded screenshots. all: every screenshot, recorded region included. none: text only.
 */
export function replayContent(r: ReplayReport, images: Images, mode: ReplayImageMode = 'failed'): Content[] {
  const content: Content[] = [{ type: 'text', text: renderReplayReport(r) }];
  if (mode === 'none') return content;
  for (const c of r.checkpoints) {
    if (mode === 'failed' && !worthShowing(c)) continue;
    const pairs: [string, string | undefined][] = [
      ...(mode === 'all' ? ([[`CP#${c.checkpoint} region, recorded`, images[c.recordedScreenshots.region]]] as [string, string | undefined][]) : []),
      [`CP#${c.checkpoint} region, replayed`, c.screenshots && images[c.screenshots.region]],
      [`CP#${c.checkpoint} viewport, replayed`, c.screenshots && images[c.screenshots.viewport]],
    ];
    for (const [label, data] of pairs) if (data) content.push({ type: 'text', text: label }, { type: 'image', data, mimeType: 'image/png' });
  }
  return content;
}
