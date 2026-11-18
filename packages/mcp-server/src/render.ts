import { renderRecordingLog, renderReplayReport, type Images, type Recording, type ReplayReport } from '@str/shared';

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

export function replayContent(r: ReplayReport, images: Images): Content[] {
  const content: Content[] = [{ type: 'text', text: renderReplayReport(r) }];
  for (const c of r.checkpoints) {
    const pairs: [string, string | undefined][] = [
      [`CP#${c.checkpoint} region, recorded`, images[c.recordedScreenshots.region]],
      [`CP#${c.checkpoint} region, replayed`, c.screenshots && images[c.screenshots.region]],
      [`CP#${c.checkpoint} viewport, replayed`, c.screenshots && images[c.screenshots.viewport]],
    ];
    for (const [label, data] of pairs) if (data) content.push({ type: 'text', text: label }, { type: 'image', data, mimeType: 'image/png' });
  }
  return content;
}
