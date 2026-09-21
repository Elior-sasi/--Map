import fs from 'node:fs';
import sharp from 'sharp';

// Finds the real drawing inside a logo image: skips transparent margins AND flat opaque margins
// (a white or coloured frame around a small mark, e.g. a 300x88 canvas with a small logo in the middle).
// Works on raw RGBA pixels, so the same code runs in the browser (canvas) and in Node (sharp).
// Never stretches: it only returns a crop window; the renderer keeps the aspect ratio.

/**
 * @param {Uint8ClampedArray|Buffer} px RGBA pixels
 * @param {number} w width  @param {number} h height
 * @returns {{x:number,y:number,w:number,h:number,bg:string|null}|null} crop in these pixel units, or null when no useful trim
 */
function findLogoBounds(px, w, h) {
  if (!w || !h) return null;
  const at = (x, y) => (y * w + x) * 4;
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => { const i = at(x, y); return [px[i], px[i + 1], px[i + 2], px[i + 3]]; });
  const transparent = corners.filter(c => c[3] < 16).length >= 3;
  let bg = null;
  if (!transparent) {
    const solid = corners.filter(c => c[3] > 240);
    if (solid.length < 3) return null;
    const avg = [0, 1, 2].map(k => Math.round(solid.reduce((a, c) => a + c[k], 0) / solid.length));
    if (solid.some(c => Math.abs(c[0] - avg[0]) + Math.abs(c[1] - avg[1]) + Math.abs(c[2] - avg[2]) > 36)) return null; // no flat frame
    bg = avg;
  }
  const isInk = i => transparent ? px[i + 3] > 24
    : px[i + 3] > 24 && (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2])) > 48;
  const cols = new Uint32Array(w), rows = new Uint32Array(h);
  let lum = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y);
    if (isInk(i)) { cols[x]++; rows[y]++; if (transparent) { lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; } }
  }
  // a white mark on a transparent canvas would vanish on the white tile - give it a dark tile instead
  const darkTile = transparent && n > 0 && lum / n > 215;
  const minC = Math.max(1, Math.round(h * 0.004)), minR = Math.max(1, Math.round(w * 0.004)); // ignore specks
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < w && cols[x0] < minC) x0++;
  while (x1 > x0 && cols[x1] < minC) x1--;
  while (y0 < h && rows[y0] < minR) y0++;
  while (y1 > y0 && rows[y1] < minR) y1--;
  if (x0 >= x1 || y0 >= y1) return null;
  const tile = bg ? `rgb(${bg[0]},${bg[1]},${bg[2]})` : darkTile ? 'rgb(32,41,55)' : null;
  // breathing room: 4% of the drawing, at least 1px, clamped to the image
  const pad = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) * 0.04));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  if (cw > w * 0.94 && ch > h * 0.94) return darkTile ? { x: 0, y: 0, w, h, bg: tile } : null; // already tight
  return { x: x0, y: y0, w: cw, h: ch, bg: tile };
}

// ---- runner (GitHub Actions): measure every store logo once and save the crop into data.json ----
// Usage: npm i --no-save sharp && node logos.mjs



const FILE = 'data.json';
const UA = 'CenterMapBot/1.0 (+https://github.com/Elior-sasi; independent map project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byUrl = new Map();
for (const b of data.businesses) if (b.logo?.url) { if (!byUrl.has(b.logo.url)) byUrl.set(b.logo.url, []); byUrl.get(b.logo.url).push(b); }

let measured = 0, cropped = 0, failed = 0;
for (const [url, list] of byUrl) {
  if (list[0].logo.frame?.checked_v === 2) continue;           // done in an earlier run
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { data: px, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = findLogoBounds(px, info.width, info.height);
    const f = r ? { x: r.x, y: r.y, w: r.w, h: r.h, sw: info.width, sh: info.height, bg: r.bg, checked_v: 2 }
                : { x: 0, y: 0, w: info.width, h: info.height, sw: info.width, sh: info.height, bg: null, checked_v: 2 };
    for (const b of list) b.logo.frame = f;
    measured++; if (r) cropped++;
  } catch (e) { failed++; console.log(`  ${url} → ${e.message}`); }
  await sleep(250);
}
fs.writeFileSync(FILE, JSON.stringify(data));
const line = `logos: ${measured} measured, ${cropped} cropped, ${failed} failed`;
console.log(line);
fs.appendFileSync('sync-report.md', `\n${line}\n`);
