import { describe, expect, it } from 'vitest';
import { combine, decide } from '../src/combine';

const t = { hide: 0.85, blur: 0.4 };
const ids = ['us_politics', 'ideology_bait'];

describe('combine', () => {
  it('takes the max of the topic questions and names it', () => {
    expect(combine({ us_politics: 0.9, ideology_bait: 0.3 }, ids, t)).toMatchObject({ score: 0.9, topQuestion: 'us_politics', decision: 'hide' });
    expect(combine({ us_politics: 0.1, ideology_bait: 0.5 }, ids, t)).toMatchObject({ score: 0.5, topQuestion: 'ideology_bait', decision: 'blur' });
  });

  it('treats missing probabilities as 0 and ignores answers to other questions', () => {
    expect(combine({ endorses_quote: 1 }, ids, t)).toEqual({ score: 0, decision: 'show', topQuestion: undefined });
  });

  it('applies thresholds inclusively at the edges', () => {
    expect(decide(0.85, t)).toBe('hide');
    expect(decide(0.8499, t)).toBe('blur');
    expect(decide(0.4, t)).toBe('blur');
    expect(decide(0.3999, t)).toBe('show');
  });
});
