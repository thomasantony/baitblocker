import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AuthorRecord, CountryRecord, LabelRecord, PostRecord } from './types';

interface BaitSchema extends DBSchema {
  posts: { key: string; value: PostRecord };
  labels: { key: number; value: LabelRecord; indexes: { postId: string } };
  authors: { key: string; value: AuthorRecord };
  countries: { key: string; value: CountryRecord };
}

export type BaitDB = IDBPDatabase<BaitSchema>;

export function openDb(name = 'baitblocker'): Promise<BaitDB> {
  return openDB<BaitSchema>(name, 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('posts', { keyPath: 'id' });
        const labels = db.createObjectStore('labels', { keyPath: 'id', autoIncrement: true });
        labels.createIndex('postId', 'postId');
        db.createObjectStore('authors', { keyPath: 'handle' });
      }
      if (oldVersion < 2) db.createObjectStore('countries', { keyPath: 'handle' });
    },
  });
}

export const normHandle = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

export const newAuthor = (handle: string): AuthorRecord => ({ handle, alpha: 1, beta: 1, seeded: false, postsSeen: 0 });

export const authorScore = (a: AuthorRecord) => a.alpha / (a.alpha + a.beta);

/** Storage operations the scorer needs; implemented over IndexedDB here and mocked in tests. */
export interface Store {
  getPost(id: string): Promise<PostRecord | undefined>;
  putPost(p: PostRecord): Promise<void>;
  getAuthor(handle: string): Promise<AuthorRecord | undefined>;
  putAuthor(a: AuthorRecord): Promise<void>;
  addLabel(l: LabelRecord): Promise<void>;
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
  getAuthor(handle: string) {
    return this.db.get('authors', normHandle(handle));
  }
  async putAuthor(a: AuthorRecord) {
    await this.db.put('authors', { ...a, handle: normHandle(a.handle) });
  }
  async addLabel(l: LabelRecord) {
    await this.db.add('labels', l);
  }
  getCountry(handle: string) {
    return this.db.get('countries', normHandle(handle));
  }
  async putCountry(c: CountryRecord) {
    await this.db.put('countries', { ...c, handle: normHandle(c.handle) });
  }
}

/** Upsert seed entries; existing alpha/beta are kept. Returns the number imported. */
export async function importSeeds(db: BaitDB, seeds: { handle: string; text?: string }[]): Promise<number> {
  const tx = db.transaction('authors', 'readwrite');
  let n = 0;
  for (const s of seeds) {
    if (!s?.handle) continue;
    const handle = normHandle(s.handle);
    if (!handle) continue;
    const existing = (await tx.store.get(handle)) ?? newAuthor(handle);
    await tx.store.put({ ...existing, seeded: true, seedText: s.text ?? existing.seedText });
    n++;
  }
  await tx.done;
  return n;
}

/** labels.jsonl: each label joined with its post record. */
export async function exportLabels(db: BaitDB): Promise<string> {
  const labels = await db.getAll('labels');
  const lines: string[] = [];
  for (const l of labels) lines.push(JSON.stringify({ ...l, post: (await db.get('posts', l.postId)) ?? null }));
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export async function exportAuthors(db: BaitDB): Promise<string> {
  const authors = await db.getAll('authors');
  return authors.map((a) => JSON.stringify({ ...a, score: authorScore(a) })).join('\n') + (authors.length ? '\n' : '');
}
