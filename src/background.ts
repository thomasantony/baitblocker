import { IdbStore, openDb } from './db';
import { Scorer } from './scorer';
import { D1Client, imageToDataUrl } from './scoring';
import { DEFAULT_SETTINGS, QUESTIONS, loadSettings, loadUsage, recordUsage } from './settings';
import type { AboutInfo } from './country';
import type { Post, Settings } from './types';

let settings: Settings = DEFAULT_SETTINGS;
let client: D1Client | undefined;

const ready = (async () => {
  settings = await loadSettings();
  client = settings.apiKey ? new D1Client(settings.apiKey, settings.model) : undefined;
  return openDb();
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
    images: async (post) => (settings.scoreImages ? Promise.all((post.imageUrls ?? []).map((u) => imageToDataUrl(u))) : []),
    budget: {
      canSpend: async () => (await loadUsage()).tokens < settings.dailyTokenBudget,
      record: recordUsage,
    },
  });
  return scorer;
}

type Msg = { type: 'score'; post: Post } | { type: 'country'; handle: string; info: AboutInfo };

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'score':
        return (await getScorer()).decide(msg.post);
      case 'country': {
        const db = await ready;
        await new IdbStore(db).putCountry({ handle: msg.handle, ...msg.info, fetchedAt: Date.now() });
        return { ok: true };
      }
    }
  })()
    .then(sendResponse)
    .catch((e) => {
      console.warn('[baitblocker]', msg.type, 'failed:', e instanceof Error ? e.message : e);
      sendResponse(undefined);
    });
  return true;
});

chrome.action?.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Chrome does not inject content scripts into tabs that were open before an install or update, and the
// copies already running there are cut off from this worker. Inject fresh copies so open x.com tabs keep
// working without a reload (the old content script notices it is orphaned and stops).
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  if (reason === 'install' && !(await loadSettings()).apiKey) chrome.runtime.openOptionsPage();
  for (const tab of await chrome.tabs.query({ url: 'https://x.com/*' })) {
    if (tab.id === undefined) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inject.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) {
      console.warn('[baitblocker] could not inject into tab', tab.id, e instanceof Error ? e.message : e);
    }
  }
});
