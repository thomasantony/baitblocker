import { openDB } from 'idb';
import { csvToSeeds } from './csv';
import { exportAuthors, exportLabels, importSeeds, openDb } from './db';
import { loadSettings, loadUsage, saveSettings } from './settings';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const dbP = openDb();

function status(id: string, msg: string, ok = true) {
  const n = $(id);
  n.textContent = msg;
  n.className = `status ${ok ? 'ok' : 'err'}`;
}

async function fill() {
  const s = await loadSettings();
  $('apiKey').value = s.apiKey;
  $<HTMLSelectElement>('model').value = s.model;
  $('budget').value = String(s.dailyTokenBudget);
  $('tHide').value = String(s.thresholds.hide);
  $('tBlur').value = String(s.thresholds.blur);
  $('enPending').checked = s.enabled.pending;
  $('enHide').checked = s.enabled.hide;
  $('enBlur').checked = s.enabled.blur;
  $('capture').checked = s.captureFixtures;
  $('allowed').value = s.allowedCountries.join(', ');
  $('scoreImages').checked = s.scoreImages;
}

$('save').addEventListener('click', async () => {
  const hide = Number($('tHide').value);
  const blur = Number($('tBlur').value);
  if (!(blur >= 0 && hide <= 1 && blur <= hide)) return status('saveStatus', 'Need 0 ≤ blur ≤ hide ≤ 1', false);
  const s = await loadSettings();
  await saveSettings({
    ...s,
    apiKey: $('apiKey').value.trim(),
    model: $<HTMLSelectElement>('model').value,
    dailyTokenBudget: Number($('budget').value) || 0,
    thresholds: { hide, blur },
    enabled: { pending: $('enPending').checked, hide: $('enHide').checked, blur: $('enBlur').checked },
    captureFixtures: $('capture').checked,
    scoreImages: $('scoreImages').checked,
    allowedCountries: $('allowed').value.split(',').map((c) => c.trim()).filter(Boolean),
  });
  status('saveStatus', 'Saved');
});

async function doImport(seeds: { handle: string; text?: string }[]) {
  const n = await importSeeds(await dbP, seeds);
  status('seedStatus', `Imported ${n} accounts`);
  stats();
}

$('importJson').addEventListener('click', async () => {
  try {
    const data = JSON.parse($<HTMLTextAreaElement>('seedJson').value);
    if (!Array.isArray(data)) throw new Error('Expected a JSON array');
    await doImport(data);
  } catch (e) {
    status('seedStatus', (e as Error).message, false);
  }
});

$('seedCsv').addEventListener('change', async () => {
  const file = $('seedCsv').files?.[0];
  if (!file) return;
  try {
    await doImport(csvToSeeds(await file.text()));
  } catch (e) {
    status('seedStatus', (e as Error).message, false);
  }
});

function download(name: string, text: string, type = 'application/x-ndjson') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('exportLabels').addEventListener('click', async () => download('labels.jsonl', await exportLabels(await dbP)));
$('exportAuthors').addEventListener('click', async () => download('authors.jsonl', await exportAuthors(await dbP)));
$('exportCaptures').addEventListener('click', async () => {
  const db = await openDB('baitblocker-debug', 1, {
    upgrade(d) {
      d.createObjectStore('captures', { keyPath: 'id', autoIncrement: true });
    },
  });
  const all = await db.getAll('captures');
  if (!all.length) return status('exportStatus', 'No captures yet: enable capture, save, and browse x.com', false);
  download('captures.json', JSON.stringify(all, null, 1), 'application/json');
  status('exportStatus', `${all.length} responses`);
});

async function stats() {
  const db = await dbP;
  const u = await loadUsage();
  const authors = await db.getAll('authors');
  const rows: [string, string | number][] = [
    ['Posts scored today', u.scored],
    ['Input tokens today', u.tokens.toLocaleString()],
    ['Today hide / blur / show', `${u.decisions.hide} / ${u.decisions.blur} / ${u.decisions.show}`],
    ['Cached posts (all time)', await db.count('posts')],
    ['Labels', await db.count('labels')],
    ['Countries cached', await db.count('countries')],
    ['Authors tracked / seeded', `${authors.length} / ${authors.filter((a) => a.seeded).length}`],
  ];
  const t = $('stats');
  t.replaceChildren(
    ...rows.map(([k, v]) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      const b = document.createElement('td');
      a.textContent = k;
      b.textContent = String(v);
      tr.append(a, b);
      return tr;
    }),
  );
}

$('refresh').addEventListener('click', stats);
fill();
stats();
