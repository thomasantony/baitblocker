// Isolated-world content script: matches DOM posts to verdicts and renders UI states.
import type { LookupResult } from './country';
import { MAX_IMAGES, scoringImageUrl } from './parser';
import { MSG_NS, type Post, type Verdict } from './types';

const posts = new Map<string, Post>();
const verdicts = new Map<string, Verdict>();
const requested = new Set<string>();
const revealed = new Set<string>();
const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Handles whose country is needed, mapped to the posts waiting on it. */
const countryWaiters = new Map<string, Set<string>>();
/** Handles whose lookup has been handed to the page script. */
const lookingUp = new Set<string>();
/** Articles on or near the screen, with the post ids they show (their own and the quoted post's). */
const onScreen = new Map<Element, string[]>();

const FALLBACK_DELAY_MS = 400;

/** Names for the question that decided a post. */
const REASONS: Record<string, string> = {
  us_politics: 'US-politics bait',
  ideology_bait: 'capitalism/socialism bait',
  anti_tech: 'anti-tech bait',
  endorses_quote: 'endorses quoted bait',
};

/**
 * False once the extension has been reloaded or updated: this copy of the script is then orphaned (Chrome
 * leaves it running in open tabs, but it can no longer reach the background) and the background has
 * injected a fresh copy, so this one must stop touching the page.
 */
function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ---------- messaging ----------

const unscored = (postId: string): Verdict => ({ postId, decision: 'unscored', reason: 'error' });

function requestVerdict(post: Post) {
  if (requested.has(post.id)) return;
  requested.add(post.id);
  chrome.runtime
    .sendMessage({ type: 'score', post })
    .then((v: Verdict | undefined) => {
      verdicts.set(post.id, v ?? unscored(post.id));
      if (v?.needsCountry) awaitCountry(post.id, v.needsCountry);
      else {
        warnSkipped(v);
        reaskQuoters(post.id);
      }
      schedule();
    })
    .catch(() => {
      // Orphaned by an extension reload: the fresh copy takes over this post.
      if (!alive()) return;
      verdicts.set(post.id, unscored(post.id));
      schedule();
    });
}

const warned = new Set<string>();
/** Scoring skipped for a reason the user can fix: say so once per page instead of failing silently. */
function warnSkipped(v: Verdict | undefined) {
  const reason = v?.decision === 'unscored' ? v.reason : undefined;
  if (!reason || warned.has(reason)) return;
  warned.add(reason);
  const why: Record<string, string> = {
    budget: "today's d1 token budget is used up (raise it in settings)",
    no_key: 'no d1 API key is set (add it in settings)',
    error: 'scoring failed (see the service worker console in chrome://extensions)',
  };
  if (why[reason]) console.warn(`[baitblocker] Posts are shown unscored: ${why[reason]}.`);
}

/** Posts quoting `quotedId` may now inherit its score (if they endorse it): ask again (answered from cache). */
function reaskQuoters(quotedId: string) {
  for (const p of posts.values()) {
    if (p.quotedId !== quotedId || !verdicts.has(p.id)) continue;
    requested.delete(p.id);
    requestVerdict(p);
  }
}

/** Notes that the post needs its author's country; it is looked up once the post is on screen. */
function awaitCountry(postId: string, handle: string) {
  let waiting = countryWaiters.get(handle);
  if (!waiting) countryWaiters.set(handle, (waiting = new Set()));
  waiting.add(postId);
  syncLookups();
}

/**
 * X allows ~50 country lookups per 15 minutes, so they are spent only on posts the user can see: asked
 * for when a waiting post comes near the screen, and cancelled (if not started yet) when it scrolls away.
 */
function syncLookups() {
  const visible = new Set([...onScreen.values()].flat());
  for (const [handle, ids] of countryWaiters) {
    const wanted = [...ids].some((id) => visible.has(id));
    if (wanted && !lookingUp.has(handle)) {
      lookingUp.add(handle);
      window.postMessage({ ns: MSG_NS, type: 'lookupCountry', handle }, location.origin);
    } else if (!wanted && lookingUp.has(handle)) {
      lookingUp.delete(handle);
      window.postMessage({ ns: MSG_NS, type: 'cancelLookup', handle }, location.origin);
    }
  }
}

async function onCountryResult(handle: string, result: LookupResult) {
  // A cancelled lookup leaves its posts waiting; they are asked for again when back on screen.
  if (!result.ok && result.error === 'cancelled') return;
  lookingUp.delete(handle);
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
    console.warn('[baitblocker] country lookup failed', handle, result.error);
    if (result.error === 'stale_query') console.info('[baitblocker] Open any profile\'s "About this account" page once so the extension can learn X\'s new query id.');
    for (const id of waiting) verdicts.set(id, unscored(id));
  }
  schedule();
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.ns !== MSG_NS || !alive()) return;
  if (e.data.type === 'posts') {
    for (const p of e.data.posts as Post[]) {
      if (!posts.has(p.id)) posts.set(p.id, p);
      requestVerdict(p);
    }
    schedule();
  } else if (e.data.type === 'countryResult' && typeof e.data.handle === 'string') {
    onCountryResult(e.data.handle, e.data.result as LookupResult);
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.settings || !alive()) return;
  // Thresholds or countries may have changed: re-ask; the background answers cached posts from stored probabilities.
  verdicts.clear();
  requested.clear();
  for (const handle of lookingUp) window.postMessage({ ns: MSG_NS, type: 'cancelLookup', handle }, location.origin);
  lookingUp.clear();
  countryWaiters.clear();
  for (const p of posts.values()) requestVerdict(p);
  schedule();
});

// ---------- DOM matching ----------

function postIdOf(article: Element): string | undefined {
  const link = article.querySelector('a[href*="/status/"] time')?.closest('a') ?? article.querySelector('a[href*="/status/"]');
  return /\/status\/(\d+)/.exec(link?.getAttribute('href') ?? '')?.[1];
}

/** Fallback for posts that never showed up in intercepted JSON. */
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
//
// State lives in our own data-bb / data-bbq attributes, not classes: X re-renders a post on hover and
// resets its `class`, which would drop a class-based blur while leaving our bar behind.

type State = 'pending' | 'hide' | 'blur' | 'show';
type QuoteState = 'blur' | 'pending' | 'show';

function stateFor(id: string): { state: State; v?: Verdict } {
  const v = verdicts.get(id);
  if (!v) return { state: 'pending' };
  if (revealed.has(id)) return { state: 'show', v };
  // Bait waiting on its author's country stays visible; it is filtered only once the country is known.
  if (v.needsCountry) return { state: 'show', v };
  if (v.decision === 'unscored') return { state: 'show', v };
  return { state: v.decision, v };
}

/** A bait quote only blurs its own box (never hidden: the quoting post usually is fine). */
function quoteStateFor(qid: string): { state: QuoteState; v?: Verdict } {
  const { state, v } = stateFor(qid);
  return { state: state === 'hide' ? 'blur' : state, v };
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

function metaText(v: Verdict): string {
  const parts = [`${REASONS[v.topQuestion ?? ''] ?? 'bait'} ${(v.score ?? 0).toFixed(2)}`];
  if (v.author) parts.push(`@${v.author}`);
  if (v.country) parts.push(`based in ${v.country}`);
  return parts.join(' · ');
}

/** Why the post is filtered, plus a "show" link; clicks never reach the post underneath. */
function bar(id: string, v: Verdict, title?: string): HTMLElement {
  const b = el('div', 'bb-bar');
  b.addEventListener('click', (e) => e.stopPropagation());
  b.append(el('span', 'bb-meta', title ? `${title} · ${metaText(v)}` : metaText(v)));
  const show = el('button', 'bb-show', 'show');
  show.type = 'button';
  show.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    revealed.add(id);
    schedule();
  });
  b.append(show);
  return b;
}

/** What one article should look like; `key` changes whenever the bar text would. */
interface Want {
  key: string;
  state: State;
  v?: Verdict;
  quote?: { id: string; state: QuoteState; v?: Verdict };
}

function want(id: string): Want {
  const { state, v } = stateFor(id);
  // The quote only matters when the quoting post itself is shown.
  const qid = state === 'show' ? posts.get(id)?.quotedId : undefined;
  const q = qid ? { id: qid, ...quoteStateFor(qid) } : undefined;
  return { key: `${id}|${state}|${v?.needsCountry ?? v?.country ?? ''}|${q?.state ?? ''}|${q?.v?.needsCountry ?? q?.v?.country ?? ''}`, state, v, quote: q };
}

/** True when the article's DOM already matches `w` (X may have re-rendered parts of it since). */
function matches(article: HTMLElement, w: Want): boolean {
  if (article.dataset.bbKey !== w.key) return false;
  if ((article.dataset.bb ?? 'show') !== w.state) return false;
  const hasBar = !!article.querySelector(':scope > .bb-bar');
  if (hasBar !== (w.state === 'hide' || w.state === 'blur')) return false;
  if (w.quote?.state === 'blur' || w.quote?.state === 'pending') {
    const box = quoteBox(article);
    if (box && box.dataset.bbq !== w.quote.state) return false;
    if (box && w.quote.state === 'blur' && !box.previousElementSibling?.classList.contains('bb-qbar')) return false;
  }
  return true;
}

function clear(article: HTMLElement) {
  delete article.dataset.bb;
  delete article.dataset.bbKey;
  article.querySelectorAll(':scope > .bb-bar, .bb-qbar').forEach((n) => n.remove());
  article.querySelectorAll<HTMLElement>('[data-bbq]').forEach((n) => delete n.dataset.bbq);
}

function render(article: HTMLElement, id: string, w: Want) {
  clear(article);
  if (w.state !== 'show') article.dataset.bb = w.state;
  // The bar sits above the post so it never covers the text; hovering a blurred post peeks.
  if (w.state === 'hide' && w.v) article.prepend(bar(id, w.v, 'Hidden'));
  else if (w.state === 'blur' && w.v) article.prepend(bar(id, w.v));
  const box = w.quote && w.quote.state !== 'show' ? quoteBox(article) : undefined;
  if (box && w.quote) {
    box.dataset.bbq = w.quote.state;
    if (w.quote.state === 'blur' && w.quote.v) {
      const qb = bar(w.quote.id, w.quote.v);
      qb.classList.add('bb-qbar');
      box.before(qb);
    }
  }
  article.dataset.bbKey = w.key;
}

const shownIds = (id: string) => [id, ...(posts.get(id)?.quotedId ? [posts.get(id)!.quotedId!] : [])];

const visibility = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const id = e.isIntersecting ? postIdOf(e.target) : undefined;
      if (id) onScreen.set(e.target, shownIds(id));
      else onScreen.delete(e.target);
    }
    syncLookups();
  },
  { rootMargin: '300px 0px' },
);

function pass() {
  for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    visibility.observe(article);
    const id = postIdOf(article);
    // X recycles article elements, so refresh what a visible one shows.
    if (onScreen.has(article)) {
      if (id) onScreen.set(article, shownIds(id));
      else onScreen.delete(article);
    }
    if (!id) {
      if (article.dataset.bbKey) clear(article);
      continue;
    }
    if (!verdicts.has(id)) ensurePost(article, id);
    // Recycled elements get a new id, so the key changes and stale UI is cleared before re-rendering.
    const w = want(id);
    if (!matches(article, w)) render(article, id, w);
  }
  for (const a of onScreen.keys()) if (!a.isConnected) onScreen.delete(a);
  syncLookups();
}

let observer: MutationObserver | undefined;
let scheduled = false;
function schedule() {
  if (!alive()) {
    observer?.disconnect();
    visibility.disconnect();
    return;
  }
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    pass();
  });
}

// ---------- styles & boot ----------

const CSS = `
article[data-bb="pending"], [data-bbq="pending"] { opacity: .5; }
/* X lays the article out as a flex row; stack our bar above the post instead of squeezing it sideways. */
article[data-bb="hide"], article[data-bb="blur"] { flex-direction: column !important; }
article[data-bb] > .bb-bar { align-self: stretch; }
article[data-bb="hide"] > :not(.bb-bar) { display: none !important; }
article[data-bb="blur"] > :not(.bb-bar) { filter: blur(12px); pointer-events: none; user-select: none; transition: filter .15s; }
article[data-bb="blur"]:hover > :not(.bb-bar) { filter: none; transition-delay: .4s; }
[data-bbq="blur"] { filter: blur(10px); pointer-events: none; user-select: none; }
.bb-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: rgb(113,118,123); }
.bb-bar.bb-qbar { padding: 6px 0; }
.bb-meta { flex: 1; min-width: 0; }
.bb-show { flex: none; align-self: flex-start; font: inherit; cursor: pointer; border: 0; background: transparent; color: rgb(29,155,240); padding: 0 0 0 4px; }
.bb-show:hover { text-decoration: underline; }
`;

function boot() {
  const style = document.createElement('style');
  style.textContent = CSS;
  (document.head ?? document.documentElement).append(style);
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bb', 'data-bbq'] });
  schedule();
}

boot();
