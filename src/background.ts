import { openDB } from 'idb';
import { IdbStore, openRbf } from './db';
import { Scorer } from './scorer';
import { D1Client } from './scoring';
import { DEFAULT_SETTINGS, QUESTIONS, loadSettings, loadUsage, recordUsage } from './settings';
import type { AboutInfo } from './country';
import type { LabelRecord, Post, Settings } from './types';

let settings: Settings = DEFAULT_SETTINGS;
let client: D1Client | undefined;

const ready = (async () => {
  settings = await loadSettings();
  client = settings.apiKey ? new D1Client(settings.apiKey, settings.model) : undefined;
  return openRbf();
})();

chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.settings) return;
  settings = await loadSettings();
  client = settings.apiKey ? new D1Client(settings.apiKey, settings.model) : undefined;
});

let scorer: Scorer | undefined;
async function getScorer(): Promise<Scorer> {
  const db = await ready;
  scorer ??= new Scorer({
    store: new IdbStore(db),
    client: () => client,
    config: QUESTIONS,
    thresholds: () => settings.thresholds,
    allowedCountries: () => settings.allowedCountries,
    budget: {
      canSpend: async () => (await loadUsage()).tokens < settings.dailyTokenBudget,
      record: recordUsage,
    },
  });
  return scorer;
}

// Debug-only store for raw timeline responses, exported from the options page into fixtures/.
const MAX_CAPTURES = 30;
const captures = openDB('rbf-debug', 1, {
  upgrade(db) {
    db.createObjectStore('captures', { keyPath: 'id', autoIncrement: true });
  },
});

async function saveCapture(url: string, body: unknown) {
  const db = await captures;
  await db.add('captures', { url, at: Date.now(), body });
  const keys = await db.getAllKeys('captures');
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CAPTURES))) await db.delete('captures', k);
}

type Msg =
  | { type: 'score'; post: Post }
  | { type: 'label'; label: Omit<LabelRecord, 'id' | 'at'> }
  | { type: 'capture'; url: string; body: unknown }
  | { type: 'country'; handle: string; info: AboutInfo };

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'score':
        return (await getScorer()).decide(msg.post);
      case 'label': {
        const db = await ready;
        await db.add('labels', { ...msg.label, at: Date.now() });
        return { ok: true };
      }
      case 'country': {
        const db = await ready;
        await new IdbStore(db).putCountry({ handle: msg.handle, ...msg.info, fetchedAt: Date.now() });
        return { ok: true };
      }
      case 'capture':
        if (settings.captureFixtures) await saveCapture(msg.url, msg.body);
        return { ok: true };
    }
  })()
    .then(sendResponse)
    .catch((e) => {
      console.warn('[rbf]', msg.type, 'failed:', e instanceof Error ? e.message : e);
      sendResponse(undefined);
    });
  return true;
});

chrome.action?.onClicked.addListener(() => chrome.runtime.openOptionsPage());
