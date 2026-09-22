// סנטר-Map · event reminders - runs daily on GitHub Actions (free).
// Reads today's data.json, finds events that happen TOMORROW (Asia/Jerusalem), and sends a Web Push to every device
// that asked to be reminded about them. Dead subscriptions (404/410) are removed.
// Secrets: FIREBASE_SERVICE_ACCOUNT (JSON), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.   Usage: node reminders.mjs [--dry]
import fs from 'node:fs';
import admin from 'firebase-admin';
import webpush from 'web-push';

const DRY = process.argv.includes('--dry');
const SITE = process.env.SITE_URL || 'https://elior-sasi.github.io/--Map/';
const clean = s => String(s || '').replace(/\s+/g, '').trim();          // pasted secrets often carry spaces/newlines

const tz = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const tomorrow = tz(new Date(Date.now() + 864e5));
const dow = new Date(`${tomorrow}T12:00:00Z`).getUTCDay();

const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const due = new Map();
for (const e of data.events || []) {
  const weekly = (e.weekly || []).find(w => w.weekday === dow);
  if (e.start === tomorrow) due.set(e.id, { e, when: e.schedule_he || '' });
  else if (weekly) due.set(e.id, { e, when: `${weekly.start_time}-${weekly.end_time}` });
}
console.log(`tomorrow ${tomorrow}: ${due.size} event(s) → ${[...due.keys()].join(', ') || '-'}`);
if (!due.size) process.exit(0);

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.log('FIREBASE_SERVICE_ACCOUNT secret is missing - nothing sent'); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
webpush.setVapidDetails('mailto:center-map@users.noreply.github.com', clean(process.env.VAPID_PUBLIC_KEY), clean(process.env.VAPID_PRIVATE_KEY));

const subs = await db.collection('subs').get();
let sent = 0, removed = 0, failed = 0;
for (const doc of subs.docs) {
  const s = doc.data(); const mine = (s.events || []).filter(id => due.has(id));
  for (const id of mine) {
    const { e, when } = due.get(id); const he = s.lang !== 'en';
    const payload = JSON.stringify({
      title: he ? `מחר בסנטר: ${e.title}` : `Tomorrow at the Center: ${e.title}`,
      body: [when, e.location_text].filter(Boolean).join(' · ') || (he ? 'דיזנגוף סנטר' : 'Dizengoff Center'),
      url: `${SITE}?view=events`, tag: `ev-${e.id}-${tomorrow}`
    });
    if (DRY) { console.log('would send', doc.id, e.id); continue; }
    try { await webpush.sendNotification(JSON.parse(s.sub), payload, { TTL: 36 * 3600 }); sent++; }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { await doc.ref.delete(); removed++; break; }
      failed++; console.log('push failed', err.statusCode, err.body || err.message);
    }
  }
}
const line = `reminders: ${sent} sent, ${removed} expired subscriptions removed, ${failed} failed (subscribers: ${subs.size})`;
console.log(line);
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', `${line}\n`);
