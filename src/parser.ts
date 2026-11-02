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

export function extractPost(tweet: Obj): Post | undefined {
  const id = tweet.rest_id;
  if (typeof id !== 'string' || !id) return undefined;
  const post: Post = {
    id,
    text: tweetText(tweet),
    author: screenName(tweet),
    isReply: typeof tweet.legacy?.in_reply_to_status_id_str === 'string',
    source: 'parser',
  };
  const quoted = unwrapTweet(tweet.quoted_status_result?.result);
  if (quoted) {
    post.quotedText = tweetText(quoted);
    post.quotedAuthor = screenName(quoted);
  }
  return post;
}

/** The same tweet can appear more than once with different detail; keep every non-empty field. */
function mergePosts(a: Post | undefined, b: Post): Post {
  if (!a) return b;
  const out: Post = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof Post, any][]) {
    if (out[k] === undefined || out[k] === '' || out[k] === false) (out as any)[k] = v;
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
