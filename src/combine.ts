import type { Decision, QuestionsConfig, Thresholds } from './types';

export interface Combined {
  score: number;
  decision: Decision;
  /** Question with the highest probability, used to name the reason in the UI. */
  topQuestion?: string;
}

/** score = max(p[max_of...], sum(w_i * p_i for weighted)) */
export function combineScore(probs: Record<string, number>, cfg: QuestionsConfig['combine']): number {
  const maxPart = Math.max(0, ...cfg.max_of.map((q) => probs[q] ?? 0));
  let weighted = 0;
  for (const [q, w] of Object.entries(cfg.weighted)) weighted += w * (probs[q] ?? 0);
  return Math.max(maxPart, weighted);
}

export function decide(score: number, t: Thresholds): Decision {
  if (score >= t.hide) return 'hide';
  if (score >= t.blur) return 'blur';
  return 'show';
}

export function topQuestion(probs: Record<string, number>): string | undefined {
  let best: string | undefined;
  for (const [q, p] of Object.entries(probs)) if (best === undefined || p > probs[best]) best = q;
  return best;
}

export function combine(probs: Record<string, number>, cfg: QuestionsConfig, thresholds = cfg.thresholds): Combined {
  const score = combineScore(probs, cfg.combine);
  return { score, decision: decide(score, thresholds), topQuestion: topQuestion(probs) };
}
