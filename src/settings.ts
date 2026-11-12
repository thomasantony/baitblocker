import questions from '../config/questions.json';
import type { Decision, QuestionsConfig, Settings, Usage } from './types';

export const QUESTIONS = questions as QuestionsConfig;

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'd1.1',
  thresholds: { ...QUESTIONS.thresholds },
  enabled: { pending: true, hide: true, blur: true },
  dailyTokenBudget: 1_000_000,
  captureFixtures: false,
  allowedCountries: ['United States', 'North America'],
  scoreImages: true,
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const s = (settings ?? {}) as Partial<Settings> & { thresholdsFor?: number };
  // Thresholds are tuned per question set, so saved ones only apply to the version they were saved under.
  const saved = s.thresholdsFor === QUESTIONS.version ? s.thresholds : undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...saved },
    enabled: { ...DEFAULT_SETTINGS.enabled, ...s.enabled },
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: { ...s, thresholdsFor: QUESTIONS.version } });
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
