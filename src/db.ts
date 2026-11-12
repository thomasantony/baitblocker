import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CountryRecord, PostRecord } from './types';

interface BaitSchema extends DBSchema {
  posts: { key: string; value: PostRecord };
  countries: { key: string; value: CountryRecord };
}

export type BaitDB = IDBPDatabase<BaitSchema>;

export function openDb(name = 'baitblocker'): Promise<BaitDB> {
  return openDB<BaitSchema>(name, 3, {
    upgrade(db) {
      // v3 dropped the labels and authors stores of the earlier design.
      for (const name of ['labels', 'authors']) if (db.objectStoreNames.contains(name as never)) db.deleteObjectStore(name as never);
      if (!db.objectStoreNames.contains('posts')) db.createObjectStore('posts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('countries')) db.createObjectStore('countries', { keyPath: 'handle' });
    },
  });
}

export const normHandle = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

/** Storage operations the scorer needs; implemented over IndexedDB here and mocked in tests. */
export interface Store {
  getPost(id: string): Promise<PostRecord | undefined>;
  putPost(p: PostRecord): Promise<void>;
  getCountry(handle: string): Promise<CountryRecord | undefined>;
  putCountry(c: CountryRecord): Promise<void>;
}

export class IdbStore implements Store {
  constructor(private db: BaitDB) {}
  getPost(id: string) {
    return this.db.get('posts', id);
  }
  async putPost(p: PostRecord) {
    await this.db.put('posts', p);
  }
  getCountry(handle: string) {
    return this.db.get('countries', normHandle(handle));
  }
  async putCountry(c: CountryRecord) {
    await this.db.put('countries', { ...c, handle: normHandle(c.handle) });
  }
}
