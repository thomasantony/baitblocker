import { describe, expect, it } from 'vitest';
import { combine, combineScore, decide } from '../src/combine';
import { QUESTIONS } from '../src/settings';

const t = { hide: 0.85, blur: 0.4 };

describe('combine', () => {
  it('takes the max of the two topic questions', () => {
    expect(combineScore({ us_politics: 0.9, ideology_bait: 0.3 }, QUESTIONS.combine)).toBeCloseTo(0.9);
    expect(combineScore({ us_politics: 0.1, ideology_bait: 0.7 }, QUESTIONS.combine)).toBeCloseTo(0.7);
  });

  it('a weighted sum still works for custom configs', () => {
    expect(combineScore({ a: 0.5, b: 1 }, { max_of: [], weighted: { a: 0.4, b: 0.2 } })).toBeCloseTo(0.4);
  });

  it('treats missing probabilities as 0', () => {
    expect(combineScore({}, QUESTIONS.combine)).toBe(0);
  });

  it('applies thresholds inclusively at the edges', () => {
    expect(decide(0.85, t)).toBe('hide');
    expect(decide(0.8499, t)).toBe('blur');
    expect(decide(0.4, t)).toBe('blur');
    expect(decide(0.3999, t)).toBe('show');
  });

  it('reports the top question', () => {
    expect(combine({ us_politics: 0.1, ideology_bait: 0.5 }, QUESTIONS, t)).toMatchObject({ topQuestion: 'ideology_bait', decision: 'blur' });
  });
});
