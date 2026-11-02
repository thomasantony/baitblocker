import { describe, expect, it } from 'vitest';
import { combine, combineScore, decide } from '../src/combine';
import { QUESTIONS } from '../src/settings';

const t = { hide: 0.85, blur: 0.4 };

describe('combine', () => {
  it('takes the max of the strong questions over the weighted sum', () => {
    expect(combineScore({ slurs: 0.9, provocation: 1, engagement_bait: 1, fabricated: 1 }, QUESTIONS.combine)).toBeCloseTo(1);
    expect(combineScore({ slurs: 0.95, provocation: 0.1 }, QUESTIONS.combine)).toBeCloseTo(0.95);
    expect(combineScore({ outgroup_contempt: 0.2, provocation: 0.8, engagement_bait: 0.5, fabricated: 0.5 }, QUESTIONS.combine)).toBeCloseTo(0.65);
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
    expect(combine({ slurs: 0.1, provocation: 0.7 }, QUESTIONS, t)).toMatchObject({ topQuestion: 'provocation', decision: 'show' });
  });
});
