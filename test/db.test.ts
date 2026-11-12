import 'fake-indexeddb/auto';
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
});
