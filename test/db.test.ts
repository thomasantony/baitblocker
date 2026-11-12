import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { IdbStore, openDb } from '../src/db';

describe('db', () => {
  it('stores posts and countries, normalizing handles', async () => {
    const store = new IdbStore(await openDb('baitblocker-test-1'));
    await store.putCountry({ handle: '@Alice', country: 'Kenya', fetchedAt: 1 });
    expect(await store.getCountry('alice')).toEqual({ handle: 'alice', country: 'Kenya', fetchedAt: 1 });
    await store.putPost({ id: '1', text: 't', seenAt: 0, probs: { us_politics: 0.9 }, questionsVersion: 1 });
    expect(await store.getPost('1')).toMatchObject({ probs: { us_politics: 0.9 } });
  });

  it('upgrades a v2 database, dropping the old labels and authors stores and keeping caches', async () => {
    const name = 'baitblocker-test-2';
    const old = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore('posts', { keyPath: 'id' });
        db.createObjectStore('labels', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('authors', { keyPath: 'handle' });
        db.createObjectStore('countries', { keyPath: 'handle' });
      },
    });
    await old.put('countries', { handle: 'bob', country: 'Denmark', fetchedAt: 1 });
    old.close();
    const db = await openDb(name);
    expect([...db.objectStoreNames].sort()).toEqual(['countries', 'posts']);
    expect(await db.get('countries', 'bob')).toMatchObject({ country: 'Denmark' });
  });
});
