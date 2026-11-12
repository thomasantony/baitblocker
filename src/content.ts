// Isolated-world content script: matches DOM posts to verdicts and renders UI states.
import type { LookupResult } from './country';
import { MAX_IMAGES, scoringImageUrl } from './parser';
import { loadSettings } from './settings';
import { MSG_NS, type LabelValue, type Post, type Settings, type Verdict } from './types';

const posts = new Map<string, Post>();
const verdicts = new Map<string, Verdict>();
const requested = new Set<string>();
const revealed = new Set<string>();
const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
let settings: Settings | undefined;

const FALLBACK_DELAY_MS = 400;
/** Questions named in the UI when they are the top reason; everything else shows as "ragebait". */
const NAMED: Record<string, string> = {
  us_politics: 'US-politics bait',
  ideology_bait: 'ideology bait',
  endorses_quote: 'endorses quoted bait',
};
/** Handles whose country lookup is in flight, mapped to the posts waiting on it. */
const countryWaiters = new Map<string, Set<string>>();

// ---------- messaging ----------

function requestVerdict(post: Post) {
  if (requested.has(post.id)) return;
  requested.add(post.id);
  chrome.runtime
    .sendMessage({ type: 'score', post })
    .then((v: Verdict | undefined) => {
      if (v?.needsCountry) return awaitCountry(post.id, v.needsCountry);
      verdicts.set(post.id, v ?? { postId: post.id, decision: 'unscored', reason: 'error' });
      reaskQuoters(post.id);
      schedule();
    })
    .catch(() => {
      // extension reloaded or worker unavailable: show the post untouched
      verdicts.set(post.id, { postId: post.id, decision: 'unscored', reason: 'error' });
      schedule();
    });
}

/** Posts quoting `quotedId` may now inherit its score (if they endorse it): ask again (answered from cache). */
function reaskQuoters(quotedId: string) {
  for (const p of posts.values()) {
    if (p.quotedId !== quotedId || !verdicts.has(p.id)) continue;
    requested.delete(p.id);
    requestVerdict(p);
  }
}

/** Leaves the post pending (dimmed) until the page script has fetched the author's country. */
function awaitCountry(postId: string, handle: string) {
  let waiting = countryWaiters.get(handle);
  if (!waiting) {
    countryWaiters.set(handle, (waiting = new Set()));
    window.postMessage({ ns: MSG_NS, type: 'lookupCountry', handle }, location.origin);
  }
  waiting.add(postId);
}

async function onCountryResult(handle: string, result: LookupResult) {
  const waiting = countryWaiters.get(handle) ?? new Set<string>();
  countryWaiters.delete(handle);
  if (result.ok) {
    await chrome.runtime.sendMessage({ type: 'country', handle, info: result.info }).catch(() => {});
    for (const id of waiting) {
      requested.delete(id);
      const p = posts.get(id);
      if (p) requestVerdict(p);
    }
  } else {
    console.debug('[rbf] country lookup failed', handle, result.error);
    if (result.error === 'stale_query') console.info('[rbf] Open any profile\'s "About this account" page once so the extension can learn X\'s new query id.');
    for (const id of waiting) verdicts.set(id, { postId: id, decision: 'unscored', reason: 'error' });
  }
  schedule();
}

function sendLabel(postId: string, label: LabelValue, source: 'user_button' | 'show_click') {
  chrome.runtime.sendMessage({ type: 'label', label: { postId, label, source } }).catch(() => {});
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.ns !== MSG_NS) return;
  if (e.data.type === 'posts') {
    for (const p of e.data.posts as Post[]) {
      if (!posts.has(p.id)) posts.set(p.id, p);
      requestVerdict(p);
    }
    schedule();
  } else if (e.data.type === 'countryResult' && typeof e.data.handle === 'string') {
    onCountryResult(e.data.handle, e.data.result as LookupResult);
  } else if (e.data.type === 'capture') {
    chrome.runtime.sendMessage({ type: 'capture', url: e.data.url, body: e.data.body }).catch(() => {});
  }
});

async function refreshSettings() {
  settings = await loadSettings();
  window.postMessage({ ns: MSG_NS, type: 'config', capture: settings.captureFixtures }, location.origin);
}

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.settings) return;
  refreshSettings().then(() => {
    // thresholds may have changed: re-ask; the background answers cached posts from stored probabilities
    verdicts.clear();
    requested.clear();
    countryWaiters.clear();
    for (const p of posts.values()) requestVerdict(p);
    schedule();
  });
});

// ---------- DOM matching ----------

function postIdOf(article: Element): string | undefined {
  const link = article.querySelector('a[href*="/status/"] time')?.closest('a') ?? article.querySelector('a[href*="/status/"]');
  return /\/status\/(\d+)/.exec(link?.getAttribute('href') ?? '')?.[1];
}

function scrapePost(article: Element, id: string): Post | undefined {
  const texts = article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]');
  const handles = [...article.querySelectorAll('[data-testid="User-Name"] a[href^="/"]')]
    .map((a) => /^\/([A-Za-z0-9_]+)$/.exec(a.getAttribute('href') ?? '')?.[1])
    .filter((h): h is string => !!h);
  const text = texts[0]?.innerText ?? '';
  const images = [...article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img')]
    .map((i) => scoringImageUrl(i.src))
    .filter((u): u is string => !!u);
  if (!text && !handles.length && !images.length) return undefined;
  return {
    id,
    text,
    author: handles[0],
    quotedText: texts[1]?.innerText,
    quotedAuthor: handles[1],
    imageUrls: images.length ? [...new Set(images)].slice(0, MAX_IMAGES) : undefined,
    isReply: false,
    source: 'dom',
  };
}

function ensurePost(article: Element, id: string) {
  if (posts.has(id) || requested.has(id) || fallbackTimers.has(id)) return;
  fallbackTimers.set(
    id,
    setTimeout(() => {
      fallbackTimers.delete(id);
      if (posts.has(id) || requested.has(id) || !article.isConnected || postIdOf(article) !== id) return;
      const p = scrapePost(article, id);
      if (!p) return;
      posts.set(id, p);
      requestVerdict(p);
    }, FALLBACK_DELAY_MS),
  );
}

// ---------- rendering ----------

type State = 'pending' | 'hide' | 'blur' | 'show';
const rendered = new WeakMap<Element, string>();

function stateFor(id: string): { state: State; v?: Verdict } {
  const v = verdicts.get(id);
  const en = settings?.enabled;
  if (!v) return { state: en?.pending === false ? 'show' : 'pending' };
  if (revealed.has(id) || v.decision === 'unscored') return { state: 'show', v };
  let d: State = v.decision;
  if (d === 'hide' && en?.hide === false) d = 'blur';
  if (d === 'blur' && en?.blur === false) d = 'show';
  return { state: d, v };
}

function clear(article: HTMLElement) {
  article.classList.remove('rbf-pending', 'rbf-hide', 'rbf-blur', 'rbf-show');
  article.querySelectorAll(':scope > .rbf-ui, .rbf-qbar').forEach((n) => n.remove());
  article.querySelectorAll('.rbf-qblur, .rbf-qpending').forEach((n) => n.classList.remove('rbf-qblur', 'rbf-qpending'));
}

/** The embedded quoted-post box: the clickable container around the post's second author name. */
function quoteBox(article: HTMLElement): HTMLElement | undefined {
  const box = article.querySelectorAll('[data-testid="User-Name"]')[1]?.closest<HTMLElement>('div[role="link"]');
  return box && article.contains(box) ? box : undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'rbf-btn', text);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Stops clicks on our UI from opening the post. */
function swallow(n: HTMLElement) {
  n.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  return n;
}

function reasonName(v: Verdict): string {
  if (v.topQuestion === 'seeded_author') return 'seeded account';
  if (v.topQuestion && NAMED[v.topQuestion]) return NAMED[v.topQuestion];
  return 'ragebait';
}

function metaText(v: Verdict): string {
  const parts = [`${reasonName(v)} ${(v.score ?? 0).toFixed(2)}`];
  if (v.author) parts.push(`@${v.author}`);
  if (v.country) parts.push(`based in ${v.country}`);
  return parts.join(' · ');
}

function reveal(id: string) {
  revealed.add(id);
  schedule();
}

/** Label buttons plus "show"; any of them reveals the post. */
function blurBar(id: string, v: Verdict, title: string): HTMLElement {
  const bar = swallow(el('div', 'rbf-ui rbf-bar rbf-blurbar'));
  bar.append(el('span', 'rbf-meta', `${title} · ${metaText(v)}`));
  for (const label of ['ragebait', 'fine'] as const) {
    bar.append(
      button(label === 'ragebait' ? 'bait' : label, () => {
        sendLabel(id, label, 'user_button');
        reveal(id);
      }),
    );
  }
  const show = button('show', () => reveal(id));
  show.classList.add('rbf-link');
  bar.append(show);
  return bar;
}

type QuoteState = 'qblur' | 'qpending' | 'none';

/** A bait quote only blurs its own box (never hidden: the quoting post usually is fine). */
function quoteStateFor(qid: string): { state: QuoteState; v?: Verdict } {
  const { state, v } = stateFor(qid);
  if (state === 'hide' || state === 'blur') return { state: 'qblur', v };
  return { state: state === 'pending' ? 'qpending' : 'none', v };
}

function renderQuote(article: HTMLElement, qid: string, state: QuoteState, v?: Verdict) {
  const box = quoteBox(article);
  if (!box || state === 'none') return;
  if (state === 'qpending') return box.classList.add('rbf-qpending');
  box.classList.add('rbf-qblur');
  const bar = blurBar(qid, v!, 'Quoted post blurred');
  bar.classList.add('rbf-qbar');
  box.before(bar);
}

function render(article: HTMLElement, id: string, state: State, v?: Verdict) {
  clear(article);
  article.classList.add(`rbf-${state}`);
  if (state === 'hide' && v) {
    const bar = swallow(el('div', 'rbf-ui rbf-bar'));
    bar.append(el('span', 'rbf-meta', `Hidden · ${metaText(v)}`));
    bar.append(
      button('show', () => {
        sendLabel(id, 'fine', 'show_click');
        reveal(id);
      }),
    );
    article.prepend(bar);
  } else if (state === 'blur' && v) {
    // Controls sit in their own bar above the post so they never cover the text; hovering the post peeks.
    article.prepend(blurBar(id, v, 'Blurred'));
  } else if (state === 'show' && settings?.enabled.flag !== false) {
    const flag = swallow(el('div', 'rbf-ui rbf-flag'));
    const toggle = button('⚑', () => flag.classList.toggle('rbf-open'));
    toggle.title = 'Label this post';
    const menu = el('div', 'rbf-menu');
    for (const label of ['ragebait'] as const) {
      menu.append(
        button('bait', () => {
          sendLabel(id, label, 'user_button');
          flag.classList.remove('rbf-open');
          flag.classList.add('rbf-done');
          toggle.textContent = '✓';
        }),
      );
    }
    flag.append(toggle, menu);
    article.prepend(flag);
  }
}

function pass() {
  for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    const id = postIdOf(article);
    if (!id) {
      if (rendered.has(article)) {
        clear(article);
        rendered.delete(article);
      }
      continue;
    }
    if (!verdicts.has(id)) ensurePost(article, id);
    const { state, v } = stateFor(id);
    // The quote only matters when the quoting post itself is shown.
    const qid = state === 'show' ? posts.get(id)?.quotedId : undefined;
    const q = qid ? quoteStateFor(qid) : undefined;
    const key = `${id}:${state}:${q?.state ?? ''}`;
    // Recycled elements get a new id, so the key changes and stale UI is cleared before re-rendering.
    const needsUi = state === 'hide' || state === 'blur' || (state === 'show' && settings?.enabled.flag !== false);
    const quoteOk = q?.state !== 'qblur' || !!article.querySelector('.rbf-qbar') || !quoteBox(article);
    if (rendered.get(article) === key && (!needsUi || article.querySelector(':scope > .rbf-ui')) && quoteOk) continue;
    render(article, id, state, v);
    if (qid && q) renderQuote(article, qid, q.state, q.v);
    rendered.set(article, key);
  }
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    pass();
  });
}

// ---------- styles & boot ----------

const CSS = `
article.rbf-pending { opacity: .5; }
article.rbf-hide, article.rbf-blur, article.rbf-show { position: relative; }
article.rbf-hide > :not(.rbf-ui) { display: none !important; }
article.rbf-blur > :not(.rbf-ui) { filter: blur(12px); pointer-events: none; user-select: none; transition: filter .15s; }
article.rbf-blur:hover > :not(.rbf-ui) { filter: none; transition-delay: .4s; }
.rbf-ui { font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: rgb(113,118,123); }
.rbf-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; }
.rbf-bar .rbf-meta { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rbf-btn { font: inherit; cursor: pointer; border: 1px solid rgb(83,100,113); background: rgba(0,0,0,.65); color: #e7e9ea; border-radius: 999px; padding: 3px 12px; }
.rbf-btn:hover { background: rgba(29,155,240,.85); border-color: transparent; }
.rbf-blurbar .rbf-btn { padding: 1px 10px; }
.rbf-bar:not(.rbf-blurbar) .rbf-btn, .rbf-bar .rbf-btn.rbf-link { background: transparent; color: rgb(29,155,240); border-color: transparent; padding: 0 0 0 4px; }
.rbf-flag { position: absolute; top: 10px; right: 52px; z-index: 2; display: flex; gap: 4px; opacity: 0; transition: opacity .1s; }
article:hover > .rbf-flag, .rbf-flag.rbf-open, .rbf-flag.rbf-done { opacity: 1; }
.rbf-flag > .rbf-btn { padding: 0 6px; }
.rbf-qpending { opacity: .5; }
.rbf-qblur { filter: blur(10px); pointer-events: none; user-select: none; }
.rbf-qbar { padding: 6px 0; }
.rbf-menu { display: none; gap: 4px; }
.rbf-flag.rbf-open .rbf-menu { display: flex; }
`;

function boot() {
  const style = document.createElement('style');
  style.textContent = CSS;
  (document.head ?? document.documentElement).append(style);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}

refreshSettings();
boot();
