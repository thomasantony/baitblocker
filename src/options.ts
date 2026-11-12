import { openDb } from './db';
import { loadSettings, loadUsage, saveSettings } from './settings';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

function status(msg: string, ok = true) {
  const n = $('saveStatus');
  n.textContent = msg;
  n.className = `status ${ok ? 'ok' : 'err'}`;
}

async function fill() {
  const s = await loadSettings();
  $('apiKey').value = s.apiKey;
  $<HTMLSelectElement>('model').value = s.model;
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
    model: $<HTMLSelectElement>('model').value,
    dailyTokenBudget: Number($('budget').value) || 0,
    scoreImages: $('scoreImages').checked,
    allowedCountries: $('allowed').value.split(',').map((c) => c.trim()).filter(Boolean),
    thresholds: { hide, blur },
  });
  status('Saved');
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
