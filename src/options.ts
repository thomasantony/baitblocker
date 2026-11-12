import { openDb } from './db';
import { D1Client } from './scoring';
import { DEFAULT_SETTINGS, QUESTIONS, loadSettings, loadUsage, recordUsage, saveSettings } from './settings';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

function status(msg: string, ok = true, id = 'saveStatus') {
  const n = $(id);
  n.textContent = msg;
  n.className = `status ${ok ? 'ok' : 'err'}`;
}

async function fill() {
  const s = await loadSettings();
  $('apiKey').value = s.apiKey;
  $('keyHint').hidden = !!s.apiKey;
  $('budget').value = String(s.dailyTokenBudget);
  $('scoreImages').checked = s.scoreImages;
  $('allowed').value = s.allowedCountries.join(', ');
  $('tHide').value = String(s.thresholds.hide);
  $('tBlur').value = String(s.thresholds.blur);
}

$('save').addEventListener('click', async () => {
  const hide = Number($('tHide').value);
  const blur = Number($('tBlur').value);
  if (!(blur >= 0 && hide <= 1 && blur <= hide)) return status('Need 0 ≤ blur ≤ hide ≤ 1', false);
  await saveSettings({
    apiKey: $('apiKey').value.trim(),
    model: DEFAULT_SETTINGS.model,
    dailyTokenBudget: Number($('budget').value) || 0,
    scoreImages: $('scoreImages').checked,
    allowedCountries: $('allowed').value.split(',').map((c) => c.trim()).filter(Boolean),
    thresholds: { hide, blur },
  });
  status('Saved');
  $('keyHint').hidden = !!$('apiKey').value.trim();
});

// One tiny single-question call, counted against today's budget like any other.
$('testKey').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) return status('Paste a key first', false, 'testStatus');
  status('Testing…', true, 'testStatus');
  try {
    const client = new D1Client(key, DEFAULT_SETTINGS.model);
    const r = await client.score({ id: 'test', text: 'Hello world' }, [QUESTIONS.questions[0]]);
    await recordUsage(r.inputTokens);
    status('Key works', true, 'testStatus');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /HTTP 40[13]/.test(msg) ? ' (key rejected)' : '';
    status(`Failed: ${msg}${hint}`, false, 'testStatus');
  }
});

async function stats() {
  const db = await openDb();
  const u = await loadUsage();
  const rows: [string, string | number][] = [
    ['Posts scored', u.scored],
    ['Input tokens', u.tokens.toLocaleString()],
    ['Topic hide / blur / show', `${u.decisions.hide} / ${u.decisions.blur} / ${u.decisions.show}`],
    ['Cached posts (all time)', await db.count('posts')],
    ['Cached countries', await db.count('countries')],
  ];
  db.close();
  $('stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const tr = document.createElement('tr');
      for (const t of [k, String(v)]) tr.append(Object.assign(document.createElement('td'), { textContent: t }));
      return tr;
    }),
  );
}

$('refresh').addEventListener('click', stats);
fill();
stats();
