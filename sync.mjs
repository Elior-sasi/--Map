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
const BASE = process.env.CM_BASE || 'https://www.dizengof-center.co.il';
const UA = 'CenterMapBot/1.0 (+https://github.com/Elior-sasi; independent map project)';
const PAUSE_MS = process.env.CM_BASE ? 0 : 700;                    // polite rate limit
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
const decode = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const clean = s => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

/**
 * The official directory is paged: /shops?pageNum=1..N. Every business is a block that starts with
 * <div data-shop="True" … item-id="…"> and holds the name (<h3>), the location text (<h4 data-cf="4467">)
 * and the opening hours per weekday (<h4 data-cf="5073"> = Sunday … "5079" = Saturday).
 * Same format the project's first import (collect-official.py) was built on.
 */
function parseShops(html) {
  const rows = [];
  for (const block of html.split(/<div\s+data-shop="True"/).slice(1)) {
    const val = re => { const m = re.exec(block); return m ? clean(m[1]) : null; };
    const id = val(/item-id="([^"]+)"/), name = val(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!id || !name) continue;
    const fields = {};
    for (const m of block.matchAll(/<h4[^>]*data-cf="(\d+)"[^>]*>([\s\S]*?)<\/h4>/g)) fields[m[1]] = clean(m[2]);
    const href = val(/<a href="([^"]+)"/);
    rows.push({
      id, name, where: fields['4467'] || '',
      weekly: [0, 1, 2, 3, 4, 5, 6].map(i => fields[String(5073 + i)] ?? null),
      category_id: val(/CategoryID="([^"]+)"/), category_name: val(/CategoryName="([^"]+)"/),
      url: href ? (href.startsWith('http') ? href : BASE + href) : null
    });
  }
  return rows;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** ["10:00-20:00", …, "סגור", null] → weekly rules (a missing day stays unknown, never guessed) */
function hoursFrom(weekly) {
  const out = [];
  weekly.forEach((raw, i) => {
    if (raw == null || String(raw).trim() === '') return;
    if (/סגור|closed/i.test(raw)) { out.push({ day: DAYS[i], closed: true, source: 'official' }); return; }
    const m = String(raw).replace(/[–—]/g, '-').match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!m) return;
    const pad = t => (t.length === 4 ? `0${t}` : t);
    out.push({ day: DAYS[i], opens: pad(m[1]), closes: pad(m[2]) === '24:00' ? '00:00' : pad(m[2]), source: 'official' });
  });
  return out;
}

const WORD_FLOORS = { 'ראשונה': 1, 'ראשון': 1, 'שנייה': 2, 'שניה': 2, 'שני': 2, 'שלישית': 3, 'שלישי': 3, 'רביעית': 4, 'רביעי': 4, 'קרקע': 0 };
/** "בניין A, קומה 1-" / "בניין B, קומה שנייה" → { building, floor } */
function parseWhere(text) {
  const building = /בניין\s*([AB])/i.exec(text);
  const fm = /קומ[הת]\s*(-?\d+(?:\.\d+)?-?|ראשונה|ראשון|שנייה|שניה|שני|שלישית|שלישי|רביעית|רביעי|קרקע)/.exec(text);
  let floor = null;
  if (fm) {
    const f = fm[1];
    floor = f in WORD_FLOORS ? WORD_FLOORS[f] : f.endsWith('-') ? -Number(f.slice(0, -1)) : Number(f);   // "1-" (RTL) → -1
    if (Number.isNaN(floor)) floor = null;
  }
  return { building: building ? building[1].toUpperCase() : null, floor };
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
      const depth = list.length > 40 ? 0.66 : 0.70;
      const inner = scaleToward(b.outline, c, depth), corr = scaleToward(b.outline, c, depth - 0.07);
      const steps = Math.max(8, Math.round(perimeter(corr) / 10));
      const ring = [];
      for (let i = 0; i < steps; i++) ring.push(node(`${fid}:C${i}`, lv.id, b.id, alongPoly(corr, i / steps).p, 'corridor'));
      for (let i = 0; i < steps; i++) edge(ring[i], ring[(i + 1) % steps]);
      corridor.set(`${b.id}|${lv.id}`, ring);
      list.forEach((biz, i) => {
        const t0 = i / list.length, t1 = (i + 1) / list.length;
        const poly = [...slicePoly(b.outline, t0 + 0.0015, t1 - 0.0015), ...slicePoly(inner, t0 + 0.0015, t1 - 0.0015).reverse()].map(round);
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
        const nd = node(`${b.id}-${lv.id}:${kind.toUpperCase()}`, lv.id, b.id, alongPoly(scaleToward(b.outline, c, 0.5), at).p, 'vertical',
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
    for (const f of facilities) {
      if (f.building !== b.id || !f.level || !/^toilet/.test(f.kind) || (f.x != null && f.position_tier !== 'schematic')) continue;
      const ring = corridor.get(`${b.id}|${f.level}`); if (!ring) continue;
      const nd = node(`${b.id}-${f.level}:WC:${f.id}`, f.level, b.id, alongPoly(scaleToward(b.outline, c, 0.5), 0.4).p, 'facility', { ref: f.id, landmark_he: 'השירותים', landmark_en: 'the restrooms' });
      let best = ring[0], bd = Infinity;
      for (const r of ring) { const dd = dist([r.x, r.y], [nd.x, nd.y]); if (dd < bd) { bd = dd; best = r; } }
      edge(nd, best);
      Object.assign(f, { x: nd.x, y: nd.y, node: nd.id, position_tier: 'schematic', note_he: 'המיקום בקומה משוער - הבניין והקומה לפי האתר הרשמי' });
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
const known = new Map(data.businesses.map(b => [/ItemID=(\d+)/.exec(b.official_url || '')?.[1] || b.id.replace(/^dc-/, ''), b]));
const levelOf = floor => floor == null ? null : data.levels.find(l => l.order === Number(floor))?.id || null;
say(`# סנטר-Map sync ${nowIso}`);
say(`known businesses: ${data.businesses.length}`);

// 1. read the whole paged directory
const seen = new Map();
for (let page = 1; page <= 40; page++) {
  let rows = [];
  try { rows = parseShops(await get(`${BASE}/shops?pageNum=${page}`)); }
  catch (e) { say(`  page ${page} → failed (${e.message})`); break; }
  const fresh = rows.filter(r => !seen.has(r.id));
  say(`  page ${page} → ${rows.length}`);
  if (!fresh.length) break;                       // past the last page (empty or repeating)
  for (const r of fresh) seen.set(r.id, r);
}
say(`discovered: ${seen.size}`);

if (seen.size < known.size * MIN_RATIO) {
  say(`ABORT: only ${seen.size} of ${known.size} known businesses were found - the site may have changed or blocked us. Nothing was written.`);
  fs.writeFileSync('sync-report.md', log.join('\n'));
  process.exit(0);
}

// 2. apply: new businesses, moves, hours, renames
const changes = [];
const addChange = (kind, biz, summary) => changes.push({
  id: `sync-${today}-${kind}-${biz?.id || Math.random().toString(36).slice(2, 7)}`,
  kind, business: biz?.id || null, at: nowIso, confirmed: kind !== 'disappeared', tier: 'official', public_log: true, summary_he: summary
});
const catByName = new Map((data.categories || []).map(c => [c.name_he, c.id]));

for (const [id, rec] of seen) {
  const where = parseWhere(rec.where);
  const hours = hoursFrom(rec.weekly);
  const level = levelOf(where.floor);
  const existing = known.get(id);
  if (!existing) {
    const biz = {
      id: `dc-${id}`, slug: `dc-${id}`, canonical_name: rec.name, name_he: rec.name, name_en: null, aliases: [],
      category: catByName.get(rec.category_name) || rec.category_id || null,
      status: 'new', tier: 'official', phone: null, website: null, description_he: null,
      hours, location_text: rec.where || null, official_url: rec.url, logo: null, products: [], topics: [], near: [], kosher: null,
      sources: { name: 'official', hours: hours.length ? 'official' : null }, created_at: nowIso, updated_at: nowIso, last_checked: nowIso
    };
    data.businesses.push(biz);
    data.locations.push({ business: biz.id, building: where.building, level, unit: null,
      precision: level ? 'floor' : where.building ? 'building' : 'venue', valid_from: today, valid_to: null, confidence: 95, source: 'official' });
    addChange('new', biz, `נפתח: ${biz.canonical_name}`);
    say(`  + ${rec.name}`);
    continue;
  }
  existing.last_checked = nowIso;
  const loc = data.locations.find(l => l.business === existing.id && !l.valid_to);
  if (loc && where.building && level && (loc.building !== where.building || loc.level !== level)) {
    const name = lv => data.levels.find(l => l.id === lv)?.name_he || lv || '';
    addChange('moved_floor', existing, `${existing.canonical_name}: עבר מבניין ${loc.building || '?'} ${name(loc.level)} לבניין ${where.building} ${name(level)}`);
    loc.valid_to = today;
    data.locations.push({ ...loc, building: where.building, level, unit: null, valid_from: today, valid_to: null });
    existing.status = 'moved'; existing.location_text = rec.where;
    say(`  → ${rec.name}: ${rec.where}`);
  }
  if (hours.length && JSON.stringify(hours) !== JSON.stringify(existing.hours)) {
    existing.hours = hours; existing.sources = { ...existing.sources, hours: 'official' };
    addChange('hours_changed', existing, `${existing.canonical_name}: שעות הפתיחה עודכנו`);
  }
  if (rec.name && rec.name !== existing.canonical_name && rec.name.length > 2) {
    addChange('renamed', existing, `שינוי שם: ${existing.canonical_name} ← ${rec.name}`);
    existing.canonical_name = rec.name; existing.name_he = rec.name;
  }
}

// 3. businesses that vanished from the site: flagged, never deleted
for (const [id, biz] of known) {
  if (seen.has(id) || biz.status === 'closed_permanently' || biz.tier === 'demo') continue;
  if (biz.pending_flag === 'possibly_closed') continue;
  biz.pending_flag = 'possibly_closed';
  addChange('disappeared', biz, `${biz.canonical_name} לא מופיע יותר באתר הרשמי - בבדיקה`);
  say(`  ? ${biz.canonical_name} missing from the site`);
}
for (const [id, biz] of known) if (seen.has(id) && biz.pending_flag === 'possibly_closed') { delete biz.pending_flag; addChange('reopened', biz, `${biz.canonical_name} חזר להופיע באתר הרשמי`); }

// 4. rebuild the schematic plan so new businesses get a spot, then save
rebuildPlan(data);                 // always: keeps the schematic layout in step with the current code and data
if (changes.length) {
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
