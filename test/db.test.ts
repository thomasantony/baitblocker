import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { exportAuthors, exportLabels, importSeeds, openDb } from '../src/db';

let n = 0;
const fresh = () => openDb(`baitblocker-test-${n++}`);

describe('db', () => {
  it('upserts seeds by normalized handle and keeps running scores', async () => {
    const db = await fresh();
    await db.put('authors', { handle: 'alice', alpha: 3, beta: 2, seeded: false, postsSeen: 4 });
    expect(await importSeeds(db, [{ handle: '@Alice', text: 'bio' }, { handle: 'bob' }, { handle: '' }])).toBe(2);
    expect(await db.get('authors', 'alice')).toEqual({ handle: 'alice', alpha: 3, beta: 2, seeded: true, seedText: 'bio', postsSeen: 4 });
    expect(await db.get('authors', 'bob')).toMatchObject({ alpha: 1, beta: 1, seeded: true });
  });

  it('exports labels joined with posts, and authors with score', async () => {
    const db = await fresh();
    await db.put('posts', { id: '1', text: 't', seenAt: 0, probs: { slurs: 0.9 }, score: 0.9, decision: 'hide', questionsVersion: 1 });
    await db.add('labels', { postId: '1', label: 'fine', source: 'show_click', at: 5 });
    await db.add('labels', { postId: 'missing', label: 'racist', source: 'user_button', at: 6 });
    const lines = (await exportLabels(db)).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ postId: '1', source: 'show_click', post: { text: 't', score: 0.9 } });
    expect(lines[1]).toMatchObject({ postId: 'missing', post: null });
    await db.put('authors', { handle: 'a', alpha: 3, beta: 1, seeded: false, postsSeen: 2 });
    expect(JSON.parse(await exportAuthors(db))).toMatchObject({ handle: 'a', score: 0.75 });
  });
});
