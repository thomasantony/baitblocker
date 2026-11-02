// Scores exported labels against a questions config and reports how decisions line up with labels.
//   npm run eval -- <labels.jsonl> [config.json] [--verbose]
// Key: $LIQUID_API_KEY or liquid_token.txt. d1 answers are cached in .eval-cache.json.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { combine } from '../src/combine';
import { D1_ENDPOINT, postToState } from '../src/scoring';
import type { Decision, QuestionsConfig } from '../src/types';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');
const [labelsPath, configPath = 'config/questions.json'] = args;
if (!labelsPath) throw new Error('usage: npm run eval -- <labels.jsonl> [config.json] [--verbose]');

const key = process.env.LIQUID_API_KEY ?? readFileSync('liquid_token.txt', 'utf8').trim();
const cfg: QuestionsConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const MODEL = 'd1.1';
const CACHE = '.eval-cache.json';
const cache: Record<string, number> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

interface Row {
  label: string;
  source: string;
  author?: string;
  state: string;
}

// One row per post; a user's own label wins over the account seed.
const rows = new Map<string, Row>();
for (const line of readFileSync(labelsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const l = JSON.parse(line);
  if (!l.post?.text && !l.post?.quotedText) continue;
  const prev = rows.get(l.postId);
  if (prev && prev.source !== 'account_seed') continue;
  rows.set(l.postId, { label: l.label, source: l.source, author: l.post.author, state: postToState({ ...l.post, isReply: false }) });
}

const cacheKey = (q: string, state: string) => createHash('sha1').update(`${MODEL}\0${q}\0${state}`).digest('hex');

async function score(state: string): Promise<Record<string, number>> {
  const missing = cfg.questions.filter((q) => cache[cacheKey(q.text, state)] === undefined);
  if (missing.length) {
    const res = await fetch(D1_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions: Object.fromEntries(missing.map((q) => [q.id, { type: 'noul', instructions: q.text }])) }),
    });
    if (!res.ok) throw new Error(`d1 HTTP ${res.status}`);
    const json: any = await res.json();
    for (const q of missing) cache[cacheKey(q.text, state)] = json.answers[q.id].noul;
  }
  return Object.fromEntries(cfg.questions.map((q) => [q.id, cache[cacheKey(q.text, state)]]));
}

const entries = [...rows.entries()];
const results: { id: string; row: Row; probs: Record<string, number>; score: number; decision: Decision; top?: string }[] = [];
for (let i = 0; i < entries.length; i += 6) {
  await Promise.all(
    entries.slice(i, i + 6).map(async ([id, row]) => {
      const probs = await score(row.state);
      const c = combine(probs, cfg);
      results.push({ id, row, probs, score: c.score, decision: c.decision, top: c.topQuestion });
    }),
  );
}
writeFileSync(CACHE, JSON.stringify(cache));

const groups: Record<string, typeof results> = {
  'user fine': results.filter((r) => r.row.source !== 'account_seed' && r.row.label === 'fine'),
  'user ragebait/racist': results.filter((r) => r.row.source !== 'account_seed' && r.row.label !== 'fine'),
  'seeded accounts (weak)': results.filter((r) => r.row.source === 'account_seed'),
};
console.log(`config ${configPath} (v${cfg.version}), thresholds hide ${cfg.thresholds.hide} / blur ${cfg.thresholds.blur}`);
for (const [name, rs] of Object.entries(groups)) {
  const n = (d: Decision) => rs.filter((r) => r.decision === d).length;
  console.log(`  ${name.padEnd(24)} n=${String(rs.length).padStart(3)}  hide ${n('hide')}  blur ${n('blur')}  show ${n('show')}`);
}
if (verbose) {
  for (const [name, rs] of Object.entries(groups).slice(0, 2)) {
    console.log(`\n${name}:`);
    for (const r of rs.sort((a, b) => b.score - a.score)) {
      const probs = Object.entries(r.probs).map(([k, v]) => `${k.slice(0, 5)}=${v.toFixed(2)}`).join(' ');
      console.log(`  ${r.decision.padEnd(4)} ${r.score.toFixed(2)}  ${probs}  ${r.row.state.slice(0, 50).replace(/\n/g, ' ')}`);
    }
  }
}
