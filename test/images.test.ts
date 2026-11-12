import { describe, expect, it, vi } from 'vitest';
import { GraphQLTimelineParser, scoringImageUrl } from '../src/parser';
import { D1Client, imageToDataUrl } from '../src/scoring';
import { QUESTIONS } from '../src/settings';

const photo = (id: string, ext = 'jpg') => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.${ext}` });
const tweet = (id: string, legacy: object, extra: object = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: { core: { screen_name: 'u' + id } } } },
  legacy: { full_text: 'text ' + id, ...legacy },
  ...extra,
});

describe('image URLs', () => {
  it('normalizes pbs media URLs to a small JPEG and rejects others', () => {
    expect(scoringImageUrl('https://pbs.twimg.com/media/HWotG3oWsAAlipI?format=png&name=small')).toBe(
      'https://pbs.twimg.com/media/HWotG3oWsAAlipI?format=jpg&name=360x360',
    );
    expect(scoringImageUrl('https://pbs.twimg.com/media/Abc-_1.png')).toBe('https://pbs.twimg.com/media/Abc-_1?format=jpg&name=360x360');
    expect(scoringImageUrl('https://pbs.twimg.com/profile_images/1/x.jpg')).toBeUndefined();
    expect(scoringImageUrl('https://evil.example/media/x.jpg')).toBeUndefined();
  });

  it('keeps photos with the post they belong to, skipping video, capped at 2', () => {
    const quoted = tweet('2', { extended_entities: { media: [photo('Q1')] } });
    const json = {
      data: tweet(
        '1',
        { extended_entities: { media: [photo('P1', 'png'), { type: 'video', media_url_https: 'https://pbs.twimg.com/media/V.jpg' }] } },
        { quoted_status_result: { result: quoted } },
      ),
    };
    const posts = new GraphQLTimelineParser().parse(json);
    const p = posts.find((x) => x.id === '1')!;
    expect(p).toMatchObject({ quotedId: '2', quotedText: 'text 2', imageUrls: ['https://pbs.twimg.com/media/P1?format=jpg&name=360x360'] });
    // The quoted tweet is its own post, scored separately with its own photo.
    expect(posts.find((x) => x.id === '2')).toMatchObject({ author: 'u2', imageUrls: ['https://pbs.twimg.com/media/Q1?format=jpg&name=360x360'] });
    const many = new GraphQLTimelineParser().parse({ data: tweet('3', { entities: { media: [photo('a'), photo('b'), photo('c')] } }) });
    expect(many[0].imageUrls).toHaveLength(2);
    expect(new GraphQLTimelineParser().parse({ data: tweet('4', {}) })[0].imageUrls).toBeUndefined();
  });
});

describe('d1 images', () => {
  it('sends images as a top-level array only when present', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1 } })));
    const c = new D1Client('k', 'd1.1', fetchImpl as unknown as typeof fetch);
    await c.score({ id: '1', text: 't', isReply: false }, QUESTIONS.questions, ['data:image/jpeg;base64,AA==']);
    await c.score({ id: '2', text: 't', isReply: false }, QUESTIONS.questions);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].images).toEqual(['data:image/jpeg;base64,AA==']);
    expect('images' in bodies[1]).toBe(false);
  });

  it('encodes fetched images as data URLs', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }));
    expect(await imageToDataUrl('https://pbs.twimg.com/media/x', fetchImpl as unknown as typeof fetch)).toBe('data:image/jpeg;base64,AQID');
    const bad = vi.fn(async () => new Response('', { status: 404 }));
    await expect(imageToDataUrl('u', bad as unknown as typeof fetch)).rejects.toThrow('404');
  });
});
