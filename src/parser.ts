import type { Post } from './types';

export interface TimelineParser {
  parse(json: unknown): Post[];
}

type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** Unwrap TweetWithVisibilityResults and similar wrappers down to a Tweet object. */
function unwrapTweet(v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined;
  if (v.__typename === 'Tweet') return v;
  if (v.__typename === 'TweetWithVisibilityResults' && isObj(v.tweet)) return unwrapTweet(v.tweet);
  return undefined;
}

function screenName(tweet: Obj): string | undefined {
  const user = tweet.core?.user_results?.result;
  const name = user?.core?.screen_name ?? user?.legacy?.screen_name;
  return typeof name === 'string' ? name : undefined;
}

function tweetText(tweet: Obj): string {
  const note = tweet.note_tweet?.note_tweet_results?.result?.text;
  if (typeof note === 'string' && note) return note;
  const full = tweet.legacy?.full_text;
  return typeof full === 'string' ? full : '';
}

/** X serves any size of a photo by query string; 360x360 is enough for d1 to read text in images. */
export const IMAGE_SIZE = '360x360';
export const MAX_IMAGES = 2;

/** Normalizes a pbs.twimg.com/media URL (any extension or query) to a small JPEG. */
export function scoringImageUrl(url: string): string | undefined {
  const m = /^https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? `https://pbs.twimg.com/media/${m[1]}?format=jpg&name=${IMAGE_SIZE}` : undefined;
}

function photoUrls(tweet: Obj): string[] {
  const media = tweet.legacy?.extended_entities?.media ?? tweet.legacy?.entities?.media;
  if (!Array.isArray(media)) return [];
  return media
    .filter((m: any) => m?.type === 'photo' && typeof m.media_url_https === 'string')
    .map((m: any) => scoringImageUrl(m.media_url_https))
    .filter((u: string | undefined): u is string => !!u);
}

export function extractPost(tweet: Obj): Post | undefined {
  const id = tweet.rest_id;
  if (typeof id !== 'string' || !id) return undefined;
  const post: Post = {
    id,
    text: tweetText(tweet),
    author: screenName(tweet),
  };
  const images = photoUrls(tweet);
  const quoted = unwrapTweet(tweet.quoted_status_result?.result);
  if (quoted) {
    post.quotedText = tweetText(quoted);
    post.quotedAuthor = screenName(quoted);
    // The walk in parse() also emits the quoted tweet as its own post, so it is scored separately.
    if (typeof quoted.rest_id === 'string' && quoted.rest_id) post.quotedId = quoted.rest_id;
    else images.push(...photoUrls(quoted));
  }
  if (images.length) post.imageUrls = [...new Set(images)].slice(0, MAX_IMAGES);
  return post;
}

/** The same tweet can appear more than once with different detail; keep every non-empty field. */
function mergePosts(a: Post | undefined, b: Post): Post {
  if (!a) return b;
  const out: Post = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof Post, any][]) {
    if (out[k] === undefined || out[k] === '') (out as any)[k] = v;
  }
  return out;
}

/** Walks any X GraphQL response and collects every Tweet it contains. Never throws. */
export class GraphQLTimelineParser implements TimelineParser {
  parse(json: unknown): Post[] {
    const out = new Map<string, Post>();
    const stack: unknown[] = [json];
    const seen = new Set<unknown>();
    while (stack.length) {
      const node = stack.pop();
      if (!isObj(node) || seen.has(node)) continue;
      seen.add(node);
      const tweet = unwrapTweet(node);
      if (tweet && tweet === node) {
        try {
          const post = extractPost(tweet);
          if (post) out.set(post.id, mergePosts(out.get(post.id), post));
        } catch {
          // tolerate any malformed tweet
        }
      }
      for (const v of Array.isArray(node) ? node : Object.values(node)) {
        if (isObj(v)) stack.push(v);
      }
    }
    return [...out.values()];
  }
}

export const TIMELINE_OPS = ['HomeTimeline', 'HomeLatestTimeline', 'TweetDetail', 'UserTweets', 'SearchTimeline'];

export function isTimelineUrl(url: string): boolean {
  const m = /\/graphql\/[^/]+\/([A-Za-z]+)/.exec(url);
  return !!m && TIMELINE_OPS.includes(m[1]);
}
