import questions from '../config/questions.json';
import type { Decision, QuestionsConfig, Settings, Usage } from './types';

export const QUESTIONS = questions as QuestionsConfig;

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'd1.1',
  thresholds: { ...QUESTIONS.thresholds },
  dailyTokenBudget: 1_000_000,
  allowedCountries: ['United States', 'North America'],
  scoreImages: true,
};

type Stored = Partial<Settings> & { thresholdsFor?: number };

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const s = (settings ?? {}) as Stored;
  // Thresholds are tuned per question set, so saved ones only apply to the version they were saved under.
  const saved = s.thresholdsFor === QUESTIONS.version ? s.thresholds : undefined;
  return {
    apiKey: s.apiKey ?? DEFAULT_SETTINGS.apiKey,
    model: s.model ?? DEFAULT_SETTINGS.model,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...saved },
    dailyTokenBudget: s.dailyTokenBudget ?? DEFAULT_SETTINGS.dailyTokenBudget,
    allowedCountries: s.allowedCountries ?? DEFAULT_SETTINGS.allowedCountries,
    scoreImages: s.scoreImages ?? DEFAULT_SETTINGS.scoreImages,
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  const stored: Stored = { ...s, thresholdsFor: QUESTIONS.version };
  await chrome.storage.local.set({ settings: stored });
}

export const today = () => new Date().toLocaleDateString('en-CA');

export const emptyUsage = (): Usage => ({ date: today(), tokens: 0, scored: 0, decisions: { hide: 0, blur: 0, show: 0 } });

export async function loadUsage(): Promise<Usage> {
  const { usage } = await chrome.storage.local.get('usage');
  const u = usage as Usage | undefined;
  return u && u.date === today() ? u : emptyUsage();
}

/** Without a decision only tokens are counted (e.g. the quote-stance follow-up call). */
export async function recordUsage(tokens: number, decision?: Decision): Promise<void> {
  const u = await loadUsage();
  u.tokens += tokens;
  if (decision) {
    u.scored++;
    u.decisions[decision]++;
  }
  await chrome.storage.local.set({ usage: u });
}
