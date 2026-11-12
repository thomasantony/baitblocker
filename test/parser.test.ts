import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GraphQLTimelineParser, isTimelineUrl } from '../src/parser';

// Synthetic fixtures mirror X's shape; add real captures (options → "captured responses") alongside them.
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const parser = new GraphQLTimelineParser();
const byId = (json: unknown) => Object.fromEntries(parser.parse(json).map((p) => [p.id, p]));

describe('GraphQLTimelineParser', () => {
  it('parses a home timeline, including visibility wrappers and both handle paths', () => {
    const p = byId(load('synthetic-home.json'));
    expect(Object.keys(p).sort()).toEqual(['100', '101', '102']);
    expect(p['100']).toMatchObject({ text: 'Plain post from alice', author: 'alice' });
    expect(p['101']).toMatchObject({ text: 'Legacy-handle post from bob', author: 'bob' });
  });

  it('prefers note_tweet text for long posts', () => {
    expect(byId(load('synthetic-home.json'))['102'].text).toBe('LONG POST full text that goes past 280 characters');
  });

  it('extracts quotes and replies, and dedupes by id', () => {
    const posts = parser.parse(load('synthetic-detail.json'));
    const p = Object.fromEntries(posts.map((x) => [x.id, x]));
    expect(posts.filter((x) => x.id === '200')).toHaveLength(1);
    expect(p['200']).toMatchObject({ author: 'dave', quotedText: 'The quoted take', quotedAuthor: 'erin' });
    expect(p['201']).toMatchObject({ author: 'erin', text: 'The quoted take' });
    expect(p['300']).toMatchObject({ author: 'frank' });
  });

  it('tolerates missing and renamed fields without throwing', () => {
    const p = byId(load('synthetic-broken.json'));
    expect(Object.keys(p).sort()).toEqual(['400', '401']);
    expect(p['401'].text).toBe('');
    expect(p['401'].author).toBeUndefined();
    expect(p['401'].quotedText).toBeUndefined();
    expect(parser.parse(null)).toEqual([]);
    expect(parser.parse('nope')).toEqual([]);
  });

  it('matches timeline operation URLs only', () => {
    expect(isTimelineUrl('https://x.com/i/api/graphql/abc123/HomeTimeline?variables=1')).toBe(true);
    expect(isTimelineUrl('https://x.com/i/api/graphql/abc123/TweetDetail')).toBe(true);
    expect(isTimelineUrl('https://x.com/i/api/graphql/abc123/UserByScreenName')).toBe(false);
    expect(isTimelineUrl('https://x.com/home')).toBe(false);
  });
});
