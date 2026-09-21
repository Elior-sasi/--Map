// סנטר-Map · weekly data sync (runs on GitHub Actions, no dependencies)
//
// Reads data.json from the repository, re-reads the official directory, and writes an updated data.json:
//   new business → added, marked "new"          · missing from the site → flagged for review, never deleted
//   floor/building change → applied + recorded  · hours change → applied
// Safety: if the fetch returns far fewer businesses than the file has (a broken page, a block, a redesign),
// the run aborts and writes nothing. Everything it does is written into data.json's `changes` list, which is
// what the app's "מה חדש בסנטר?" screen shows.
//
// Usage: node sync.mjs [--dry]

import fs from 'node:fs';

const DRY = process.argv.includes('--dry');
const FILE = 'data.json';
const BASE = 'https://www.dizengof-center.co.il';
const UA = 'CenterMapBot/1.0 (+https://github.com/Elior-sasi; independent map project)';
const PAUSE_MS = 700;                    // polite rate limit
const MIN_RATIO = 0.6;                   // abort if we see less than 60% of the known businesses

const log = [];
const say = (...a) => { const line = a.join(' '); log.push(line); console.log(line); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const nowIso = new Date().toISOString();

async function get(url) {
  await sleep(PAUSE_MS);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}

// ---------- tiny HTML helpers (no dependencies) ----------
const stripTags = s => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const clean = s => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

/** Business pages look like /shops/<category>/?ItemID=12345 - collect ids and names from a listing page. */
function parseListing(html) {
  const out = new Map();
  const re = /<a[^>]+href="([^"]*ItemID=(\d+)[^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, href, id, inner] = m;
    const name = clean(inner).slice(0, 80);
    if (!name) continue;
    const prev = out.get(id);
    if (!prev || name.length > prev.name.length) out.set(id, { id, name, url: href.startsWith('http') ? href : BASE + href });
  }
  return [...out.values()];
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** "א'-ה' 10:00-20:00 ו' 9:00-15:00 מוצ"ש סגור" → weekly rules */
function parseHours(text) {
  const t = text.replace(/[–—]/g, '-');
  const grab = re => { const m = re.exec(t); return m ? [m[1], m[2]] : null; };
  const closed = re => re.test(t);
  const week = grab(/א['׳]?\s*-\s*ה['׳]?[^0-9]{0,12}(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  const fri = grab(/ו['׳][^0-9]{0,12}(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  const sat = grab(/(?:מוצ["״]?ש|שבת)[^0-9]{0,12}(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  const satClosed = closed(/(?:מוצ["״]?ש|שבת)[^0-9]{0,12}סגור/);
  if (!week && !fri && !sat) return null;
  const pad = x => (x.length === 4 ? `0${x}` : x);
  const rules = [];
  for (const d of ['sun', 'mon', 'tue', 'wed', 'thu']) if (week) rules.push({ day: d, opens: pad(week[0]), closes: pad(week[1]), source: 'official' });
  if (fri) rules.push({ day: 'fri', opens: pad(fri[0]), closes: pad(fri[1]), source: 'official' });
  if (sat) rules.push({ day: 'sat', opens: pad(sat[0]), closes: pad(sat[1]), source: 'official' });
  else if (satClosed) rules.push({ day: 'sat', closed: true, source: 'official' });
  return rules.length ? rules : null;
}

function parseWhere(text) {
  const building = /בניין\s*([AB])/i.exec(text);
  const floorRaw = /קומה\s*(\d+-(?!\d)|-?\d+)/.exec(text);
  let floor = floorRaw ? floorRaw[1] : null;
  if (floor && /^\d+-$/.test(floor)) floor = `-${floor.slice(0, -1)}`;   // "1-" (RTL) → "-1"
  const phone = /0\d{1,2}-?\d{7}/.exec(text);
  return { building: building ? building[1].toUpperCase() : null, floor: floor != null ? Number(floor) : null, phone: phone ? phone[0] : null };
}

// ---------- schematic plan (same algorithm the project ships with) ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const round = p => [+p[0].toFixed(2), +p[1].toFixed(2)];
function centroid(poly) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; x += (poly[j][0] + poly[i][0]) * f; y += (poly[j][1] + poly[i][1]) * f;
  }
  a *= 0.5; return Math.abs(a) < 1e-6 ? poly[0] : [x / (6 * a), y / (6 * a)];
}
const scaleToward = (poly, c, k) => poly.map(p => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
const perimeter = poly => poly.reduce((s, p, i) => s + dist(p, poly[(i + 1) % poly.length]), 0);
function alongPoly(poly, t) {
  const total = perimeter(poly); let want = ((t % 1) + 1) % 1 * total;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], L = dist(a, b);
    if (want <= L) return { p: lerp(a, b, L ? want / L : 0), i };
    want -= L;
  }
  return { p: poly[0], i: 0 };
}
function slicePoly(poly, t0, t1) {
  const pts = []; const s = alongPoly(poly, t0), e = alongPoly(poly, t1);
  pts.push(s.p);
  let i = (s.i + 1) % poly.length;
  for (let n = 0; n < poly.length + 2; n++) { if (i === (e.i + 1) % poly.length) break; pts.push(poly[i]); i = (i + 1) % poly.length; }
  pts.push(e.p); return pts;
}
function rebuildPlan(d) {
  const levels = d.levels, buildings = d.buildings;
  const byBF = new Map();
  for (const b of d.businesses) {
    const l = d.locations.find(x => x.business === b.id && !x.valid_to);
    if (!l?.building || !l.level) continue;
    const k = `${l.building}|${l.level}`;
    (byBF.get(k) || byBF.set(k, []).get(k)).push(b);
    l.unit = null;
  }
  const units = [], nodes = [], edges = [], verticals = [], corridor = new Map();
  const facilities = d.facilities.filter(f => f.tier !== 'schematic');
  const node = (id, level, building, p, kind, extra = {}) => { const n = { id, level, building, x: round(p)[0], y: round(p)[1], kind, ...extra }; nodes.push(n); return n; };
  const edge = (a, b, extra = {}) => edges.push({ a: a.id, b: b.id, d: +dist([a.x, a.y], [b.x, b.y]).toFixed(1), kind: 'walk', accessible: true, ...extra });
  const cores = { A: [0.18, 0.62], B: [0.24, 0.68] };
  let seq = 0;
  for (const b of buildings) {
    const c = centroid(b.outline);
    for (const lv of levels) {
      const list = (byBF.get(`${b.id}|${lv.id}`) || []).slice().sort((x, y) => (x.category || '').localeCompare(y.category || '') || x.canonical_name.localeCompare(y.canonical_name, 'he'));
      const fid = `${b.id}-${lv.id}`;
      const depth = list.length > 40 ? 0.80 : 0.84;
      const inner = scaleToward(b.outline, c, depth), corr = scaleToward(b.outline, c, depth - 0.07);
      const steps = Math.max(8, Math.round(perimeter(corr) / 10));
      const ring = [];
      for (let i = 0; i < steps; i++) ring.push(node(`${fid}:C${i}`, lv.id, b.id, alongPoly(corr, i / steps).p, 'corridor'));
      for (let i = 0; i < steps; i++) edge(ring[i], ring[(i + 1) % steps]);
      corridor.set(`${b.id}|${lv.id}`, ring);
      list.forEach((biz, i) => {
        const t0 = i / list.length, t1 = (i + 1) / list.length;
        const poly = [...slicePoly(b.outline, t0 + 0.0015, t1 - 0.0015), ...slicePoly(inner, t1 - 0.0015, t0 + 0.0015)].map(round);
        const mid = lerp(alongPoly(inner, t0).p, alongPoly(inner, t1).p, 0.5);
        const label = round(lerp(mid, lerp(alongPoly(b.outline, t0).p, alongPoly(b.outline, t1).p, 0.5), 0.45));
        seq++;
        const id = `CENTER-${b.id}-${lv.id.replace('floor-', 'F')}-${String(seq).padStart(4, '0')}`;
        const door = node(`${fid}:door:${id}`, lv.id, b.id, lerp(mid, alongPoly(corr, (t0 + t1) / 2).p, 0.6), 'door', { ref: id });
        let best = ring[0], bd = Infinity;
        for (const r of ring) { const dd = dist([r.x, r.y], [door.x, door.y]); if (dd < bd) { bd = dd; best = r; } }
        edge(door, best);
        units.push({ id, floor: fid, level: lv.id, building: b.id, kind: 'retail', poly, label, door: door.id, tier: 'schematic' });
        d.locations.find(l => l.business === biz.id && !l.valid_to).unit = id;
      });
    }
    for (const [kind, at, acc] of [['elevator', cores[b.id]?.[0] ?? 0.2, true], ['escalator', cores[b.id]?.[1] ?? 0.65, false]]) {
      const vid = `${b.id}-${kind}-1`, per = [];
      for (const lv of levels) {
        const ring = corridor.get(`${b.id}|${lv.id}`); if (!ring) continue;
        const nd = node(`${b.id}-${lv.id}:${kind.toUpperCase()}`, lv.id, b.id, alongPoly(scaleToward(b.outline, c, 0.68), at).p, 'vertical',
          { ref: vid, landmark_he: kind === 'elevator' ? 'המעלית' : 'הדרגנוע', landmark_en: kind === 'elevator' ? 'the elevator' : 'the escalator' });
        let best = ring[0], bd = Infinity;
        for (const r of ring) { const dd = dist([r.x, r.y], [nd.x, nd.y]); if (dd < bd) { bd = dd; best = r; } }
        edge(nd, best); per.push({ lv, nd });
        facilities.push({ id: `${vid}-${lv.id}`, kind, building: b.id, level: lv.id, floor: `${b.id}-${lv.id}`, x: nd.x, y: nd.y, node: nd.id,
          name_he: `${kind === 'elevator' ? 'מעלית' : 'דרגנוע'} (${b.id})`, name_en: `${kind} (${b.id})`, accessible: acc, tier: 'schematic', position_tier: 'schematic', note_he: 'מיקום סכמטי' });
      }
      per.sort((x, y) => x.lv.order - y.lv.order);
      for (let i = 0; i < per.length - 1; i++) {
        const gap = Math.abs(per[i + 1].lv.order - per[i].lv.order);
        edge(per[i].nd, per[i + 1].nd, { d: kind === 'elevator' ? 4 : 12 * gap, kind, floor_change: true, accessible: acc, vertical: vid });
      }
      verticals.push({ id: vid, kind, building: b.id, levels: levels.map(l => l.id), accessible: acc, tier: 'schematic' });
    }
  }
  // bridges (levels 2-3) and gates, from the geometry already in the file
  (d.areas || []).filter(a => a.kind === 'bridge').forEach((br, i) => {
    const cbr = centroid(br.poly), ends = {};
    for (const b of buildings) {
      const ring = corridor.get(`${b.id}|${br.level}`); if (!ring) continue;
      let best = ring[0], bd = Infinity;
      for (const r of ring) { const dd = dist([r.x, r.y], cbr); if (dd < bd) { bd = dd; best = r; } }
      const nd = node(`BR${i}:${b.id}`, br.level, b.id, lerp([best.x, best.y], cbr, 0.75), 'bridge');
      edge(nd, best); ends[b.id] = nd;
    }
    if (ends.A && ends.B) edge(ends.A, ends.B, { kind: 'bridge', name: br.label_he, name_en: br.label_en });
  });
  const MAIN = 'floor-1';
  for (const e of d.entrances) {
    if (e.x == null || !e.building) continue;
    const ring = corridor.get(`${e.building}|${MAIN}`); if (!ring) continue;
    const nd = node(`GATE-${e.number}`, MAIN, e.building, [e.x, e.y], 'entrance', { ref: e.id, landmark_he: e.name_he, landmark_en: e.name_en });
    let best = ring[0], bd = Infinity;
    for (const r of ring) { const dd = dist([r.x, r.y], [nd.x, nd.y]); if (dd < bd) { bd = dd; best = r; } }
    edge(nd, best); e.node = nd.id; e.level = MAIN;
  }
  d.units = units; d.facilities = facilities; d.verticals = verticals; d.graph = { nodes, edges };
}

// ---------- main ----------
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const known = new Map(data.businesses.filter(b => b.official_url).map(b => {
  const id = /ItemID=(\d+)/.exec(b.official_url)?.[1];
  return [id || b.id, b];
}));
say(`# סנטר-Map sync ${nowIso}`);
say(`known businesses: ${data.businesses.length}`);

// 1. discover: every category listing the current data points at
const catPaths = [...new Set(data.businesses.map(b => (b.official_url || '').match(/\/shops\/[^/?]+\//)?.[0]).filter(Boolean))];
say(`category pages: ${catPaths.length}`);
const seen = new Map();
for (const p of catPaths) {
  try {
    const html = await get(BASE + p);
    const found = parseListing(html);
    for (const f of found) if (!seen.has(f.id)) seen.set(f.id, { ...f, category_path: p });
    say(`  ${p} → ${found.length}`);
  } catch (e) { say(`  ${p} → failed (${e.message})`); }
}
say(`discovered: ${seen.size}`);

if (seen.size < known.size * MIN_RATIO) {
  say(`ABORT: only ${seen.size} of ${known.size} known businesses were found - the site may have changed or blocked us. Nothing was written.`);
  fs.writeFileSync('sync-report.md', log.join('\n'));
  process.exit(0);
}

// 2. details for new and for a rotating slice of the existing ones (keeps each run short)
const changes = [];
const addChange = (kind, biz, summary) => changes.push({
  id: `sync-${today}-${kind}-${biz?.id || Math.random().toString(36).slice(2, 7)}`,
  kind, business: biz?.id || null, at: nowIso, confirmed: kind !== 'disappeared', tier: 'official', public_log: true, summary_he: summary
});

const week = Math.floor(Date.now() / 6048e5) % 4;                 // details refresh: a quarter of the list each week
const newIds = [...seen.keys()].filter(id => !known.has(id));
const refresh = [...known.keys()].filter((id, i) => i % 4 === week);
say(`new: ${newIds.length} · detail refresh this run: ${refresh.length}`);

for (const id of [...newIds, ...refresh]) {
  const rec = seen.get(id);
  if (!rec) continue;
  let text = '';
  try { text = clean(await get(rec.url)); } catch (e) { say(`  ItemID=${id} → ${e.message}`); continue; }
  const where = parseWhere(text);
  const hours = parseHours(text);
  const existing = known.get(id);
  if (!existing) {
    const biz = {
      id: `dc-${id}`, slug: `dc-${id}`, canonical_name: rec.name, name_he: rec.name, name_en: null, aliases: [],
      category: data.businesses.find(b => (b.official_url || '').includes(rec.category_path))?.category || null,
      status: 'new', tier: 'official', phone: where.phone, website: null, description_he: null,
      hours: hours || [], location_text: null, official_url: rec.url, logo: null, products: [], topics: [], near: [], kosher: null,
      sources: { name: 'official', hours: hours ? 'official' : null }, created_at: nowIso, updated_at: nowIso, last_checked: nowIso
    };
    data.businesses.push(biz);
    data.locations.push({ business: biz.id, building: where.building, level: where.floor != null ? `floor-${where.floor}` : null, unit: null,
      precision: where.floor != null ? 'floor' : where.building ? 'building' : 'venue', valid_from: today, valid_to: null, confidence: 95, source: 'official' });
    addChange('new', biz, `נפתח: ${biz.canonical_name}`);
    say(`  + ${rec.name}`);
    continue;
  }
  existing.last_checked = nowIso;
  const loc = data.locations.find(l => l.business === existing.id && !l.valid_to);
  const newLevel = where.floor != null ? `floor-${where.floor}` : loc?.level;
  if (loc && where.building && (loc.building !== where.building || loc.level !== newLevel)) {
    addChange('moved_floor', existing, `${existing.canonical_name}: עבר מ${loc.building || ''} ${loc.level || ''} ל${where.building} ${newLevel || ''}`);
    loc.valid_to = today;
    data.locations.push({ ...loc, building: where.building, level: newLevel, unit: null, valid_from: today, valid_to: null });
    existing.status = 'moved';
  }
  if (hours && JSON.stringify(hours) !== JSON.stringify(existing.hours)) {
    existing.hours = hours; existing.sources = { ...existing.sources, hours: 'official' };
    addChange('hours_changed', existing, `${existing.canonical_name}: שעות הפתיחה עודכנו`);
  }
  if (where.phone && where.phone !== existing.phone) { existing.phone = where.phone; existing.sources = { ...existing.sources, phone: 'official' }; }
  if (rec.name && rec.name !== existing.canonical_name && rec.name.length > 2) {
    addChange('renamed', existing, `שינוי שם: ${existing.canonical_name} ← ${rec.name}`);
    existing.canonical_name = rec.name;
  }
}

// 3. businesses that vanished from the site: flagged, never deleted
for (const [id, biz] of known) {
  if (seen.has(id) || biz.status === 'closed_permanently') continue;
  if (biz.pending_flag === 'possibly_closed') continue;
  biz.pending_flag = 'possibly_closed';
  addChange('disappeared', biz, `${biz.canonical_name} לא מופיע יותר באתר הרשמי - בבדיקה`);
  say(`  ? ${biz.canonical_name} missing from the site`);
}
for (const [id, biz] of known) if (seen.has(id) && biz.pending_flag === 'possibly_closed') { delete biz.pending_flag; addChange('reopened', biz, `${biz.canonical_name} חזר להופיע באתר הרשמי`); }

// 4. rebuild the schematic plan so new businesses get a spot, then save
if (changes.length) {
  rebuildPlan(data);
  data.changes = [...changes, ...(data.changes || [])].slice(0, 400);
  data.meta.version = `real-plan-${today}`;
  data.meta.today = today;
  data.meta.last_sync = nowIso;
  if (!DRY) fs.writeFileSync(FILE, JSON.stringify(data));
  say(`\n${changes.length} changes written${DRY ? ' (dry run - file untouched)' : ''}:`);
  for (const c of changes.slice(0, 40)) say(`  - ${c.summary_he}`);
} else {
  data.meta.last_sync = nowIso;
  if (!DRY) fs.writeFileSync(FILE, JSON.stringify(data));
  say('\nno changes');
}
fs.writeFileSync('sync-report.md', log.join('\n'));
