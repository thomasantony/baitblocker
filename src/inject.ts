// MAIN-world script: observes X's GraphQL timeline responses without altering them.
import { GraphQLTimelineParser, isTimelineUrl } from './parser';
import { MSG_NS } from './types';

const parser = new GraphQLTimelineParser();
let capture = false;

window.addEventListener('message', (e) => {
  if (e.source === window && e.data?.ns === MSG_NS && e.data.type === 'config') capture = !!e.data.capture;
});

function handle(url: string, json: unknown) {
  try {
    const posts = parser.parse(json);
    if (posts.length) window.postMessage({ ns: MSG_NS, type: 'posts', posts }, location.origin);
    if (capture) window.postMessage({ ns: MSG_NS, type: 'capture', url, body: json }, location.origin);
  } catch {
    // never let parsing affect the page
  }
}

const origFetch = window.fetch;
window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
  const res = await origFetch.apply(this, args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isTimelineUrl(url)) {
      res
        .clone()
        .json()
        .then((j) => handle(url, j), () => {});
    }
  } catch {
    // ignore
  }
  return res;
};

const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
  const href = String(url);
  if (isTimelineUrl(href)) {
    this.addEventListener('load', () => {
      try {
        const body =
          this.responseType === 'json' ? this.response : this.responseType === '' || this.responseType === 'text' ? JSON.parse(this.responseText) : undefined;
        if (body) handle(href, body);
      } catch {
        // ignore
      }
    });
  }
  return (origOpen as any).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;
