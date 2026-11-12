// MAIN-world script: observes X's GraphQL timeline responses without altering them.
import { CountryFetcher, DEFAULT_ABOUT_QUERY_ID, DEFAULT_BEARER, aboutQueryId } from './country';
import { GraphQLTimelineParser, isTimelineUrl } from './parser';
import { MSG_NS } from './types';

const parser = new GraphQLTimelineParser();

// ---------- account-country lookups (run here so they carry the user's X session) ----------

const QID_KEY = 'baitblocker:aboutQueryId';
let queryId = safeGet(QID_KEY) ?? DEFAULT_ABOUT_QUERY_ID;
let bearer = DEFAULT_BEARER;

function safeGet(k: string): string | undefined {
  try {
    return localStorage.getItem(k) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Learn the current AboutAccountQuery id and bearer from X's own requests. */
function observeRequest(url: string, auth?: string | null) {
  if (auth && /^Bearer /.test(auth)) bearer = auth;
  const id = aboutQueryId(url);
  if (id && id !== queryId) {
    queryId = id;
    try {
      localStorage.setItem(QID_KEY, id);
    } catch {
      // ignore
    }
  }
}

// Captured before wrapping, so our own lookups are not observed as X traffic.
const origFetch = window.fetch;

const fetcher = new CountryFetcher({
  fetch: (...a) => origFetch(...a),
  queryId: () => queryId,
  headers: () => ({
    authorization: bearer,
    'x-csrf-token': /(?:^|; )ct0=([^;]+)/.exec(document.cookie)?.[1] ?? '',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
  }),
});

// The background re-injects this script into open tabs after an extension update; an earlier copy may
// already be installed in the page, so install the listeners and fetch/XHR wrappers only once.
const INSTALLED = '__baitblockerInjected';
if (!(window as any)[INSTALLED]) {
  (window as any)[INSTALLED] = true;
  install();
}

function install() {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.ns !== MSG_NS) return;
    if (e.data.type === 'lookupCountry' && typeof e.data.handle === 'string') {
      const handle: string = e.data.handle;
      fetcher.lookup(handle).then((result) => window.postMessage({ ns: MSG_NS, type: 'countryResult', handle, result }, location.origin));
    } else if (e.data.type === 'cancelLookup' && typeof e.data.handle === 'string') fetcher.cancel(e.data.handle);
  });

  function handle(json: unknown) {
    try {
      const posts = parser.parse(json);
      if (posts.length) window.postMessage({ ns: MSG_NS, type: 'posts', posts }, location.origin);
    } catch {
      // never let parsing affect the page
    }
  }

  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const h = args[1]?.headers ?? (input instanceof Request ? input.headers : undefined);
      observeRequest(url, h instanceof Headers ? h.get('authorization') : Array.isArray(h) ? undefined : (h as any)?.authorization);
      if (isTimelineUrl(url)) {
        res
          .clone()
          .json()
          .then(handle, () => {});
      }
    } catch {
      // ignore
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    const href = String(url);
    observeRequest(href);
    if (isTimelineUrl(href)) {
      this.addEventListener('load', () => {
        try {
          const body =
            this.responseType === 'json' ? this.response : this.responseType === '' || this.responseType === 'text' ? JSON.parse(this.responseText) : undefined;
          if (body) handle(body);
        } catch {
          // ignore
        }
      });
    }
    return (origOpen as any).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    if (name.toLowerCase() === 'authorization') observeRequest('', value);
    return origSetHeader.call(this, name, value);
  };
}
