/** Screenshot helpers. Images are base64 PNG throughout (what CDP returns and MCP expects). */

export const MAX_IMAGE_WIDTH = 1280;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/**
 * Crops a region (in CSS pixels of a `css`-sized viewport) out of a screenshot and downscales
 * the result to at most MAX_IMAGE_WIDTH pixels wide. Without a region, the whole screenshot is
 * downscaled. Pixels are mapped per axis, so a surface that is not exactly viewport x DPR still lines up.
 */
export async function cropAndScale(pngBase64: string, region: Box | null, css: { width: number; height: number }, maxWidth = MAX_IMAGE_WIDTH): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(pngBase64)], { type: 'image/png' }));
  const sxScale = bitmap.width / css.width;
  const syScale = bitmap.height / css.height;
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (region) {
    sx = Math.max(0, Math.floor(region.x * sxScale));
    sy = Math.max(0, Math.floor(region.y * syScale));
    sw = Math.max(1, Math.min(bitmap.width - sx, Math.ceil(region.width * sxScale)));
    sh = Math.max(1, Math.min(bitmap.height - sy, Math.ceil(region.height * syScale)));
  }
  // Keep the region's CSS proportions in the output.
  const cssW = region ? region.width : css.width;
  const cssH = region ? region.height : css.height;
  const outW = Math.max(1, Math.min(maxWidth, sw));
  const outH = Math.max(1, Math.round((outW * cssH) / cssW));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(pngBase64: string): { width: number; height: number } {
  const b = base64ToBytes(pngBase64.slice(0, 64));
  const view = new DataView(b.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

interface Capturer {
  send<T = any>(method: string, params?: { [key: string]: unknown }): Promise<T>;
}

/**
 * Screenshot of the visible viewport and its CSS size. Deliberately unclipped: a clipped
 * capture resets device emulation on the tab (for example DevTools device mode).
 */
export async function captureViewport(cdp: Capturer): Promise<{ data: string; css: { width: number; height: number } }> {
  const { cssVisualViewport: vv } = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  return { data: shot.data, css: { width: vv.clientWidth, height: vv.clientHeight } };
}
