import { describe, expect, it } from 'vitest';
import { csvToSeeds } from '../src/csv';

describe('csvToSeeds', () => {
  it('reads handles and descriptions with quotes, commas and newlines', () => {
    const csv = 'account_handle,display_name,description,verified,status\n"@a","A","hi, ""there""\nline2","no","Blocked"\n"@b","B","","yes","Blocked"\n';
    expect(csvToSeeds(csv)).toEqual([
      { handle: '@a', text: 'hi, "there"\nline2' },
      { handle: '@b', text: '' },
    ]);
  });
});
