export const MIN_CHOICES = 2;
export const MAX_CHOICES = 8;
export const MAX_CHOICE_LENGTH = 128;
export const CHOICE_TTL_MS = 10 * 60 * 1000;

export interface ChoiceOption {
  label: string;
  value?: string;
}

export interface ChoiceCallbackEffects {
  answer(text?: string): Promise<void>;
  removeKeyboard(): Promise<void>;
  beginTyping(): void;
  endTyping(): void;
}

export interface ChoiceCallback {
  id: string;
  data?: string;
  chatId?: string | number;
  messageId?: number;
}

export interface PendingChoice {
  id: string;
  question: string;
  options: ChoiceOption[];
  defaultChatId: string;
  expiresAt: number;
  answered: boolean;
  onAnswer?: (option: ChoiceOption, effects: ChoiceCallbackEffects) => Promise<void>;
  /** Called exactly once when the pending choice is dropped (expiry or cleanup). */
  onExpire?: () => void;
}

const choicesByProject = new Map<string, Map<string, PendingChoice>>();

export function validateChoices(options: readonly ChoiceOption[]): string | undefined {
  if (options.length < MIN_CHOICES || options.length > MAX_CHOICES) {
    return `Choices must contain between ${MIN_CHOICES} and ${MAX_CHOICES} options`;
  }
  for (const option of options) {
    if (option.label.length > MAX_CHOICE_LENGTH || (option.value?.length ?? 0) > MAX_CHOICE_LENGTH) {
      return `Choice labels and values must be at most ${MAX_CHOICE_LENGTH} characters`;
    }
  }
  return undefined;
}

export function choiceCallbackData(id: string, index: number): string {
  return `pc:${id}:${index}`;
}

export function parseChoiceCallbackData(data: string): { id: string; index: number } | undefined {
  const match = /^pc:([^:]+):(\d+)$/.exec(data);
  if (!match) return undefined;
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) return undefined;
  return { id: match[1]!, index };
}

export function registerChoice(projectRoot: string, choice: PendingChoice): void {
  const choices = choicesByProject.get(projectRoot) ?? new Map<string, PendingChoice>();
  choices.set(choice.id, choice);
  choicesByProject.set(projectRoot, choices);
}

export function isChoiceExpired(choice: PendingChoice, now: number): boolean {
  return now >= choice.expiresAt;
}

export function resolveChoice(projectRoot: string, id: string, index?: number): PendingChoice | undefined {
  const choice = choicesByProject.get(projectRoot)?.get(id);
  if (!choice) return undefined;
  if (index !== undefined && (index < 0 || index >= choice.options.length)) return undefined;
  return choice;
}

export function markChoiceAnswered(projectRoot: string, id: string): PendingChoice | undefined {
  const choice = resolveChoice(projectRoot, id);
  if (!choice || choice.answered) return undefined;
  choice.answered = true;
  return choice;
}

export function deleteChoice(projectRoot: string, id: string): void {
  const choices = choicesByProject.get(projectRoot);
  const choice = choices?.get(id);
  choices?.delete(id);
  choice?.onExpire?.();
  if (choices?.size === 0) choicesByProject.delete(projectRoot);
}

export function clearChoices(projectRoot: string): void {
  choicesByProject.delete(projectRoot);
}

export function resetChoices(): void {
  choicesByProject.clear();
}

export async function dispatchChoiceCallback(
  projectRoot: string,
  callback: ChoiceCallback,
  effects: ChoiceCallbackEffects,
  now = Date.now(),
): Promise<void> {
  const parsed = callback.data === undefined ? undefined : parseChoiceCallbackData(callback.data);
  if (!parsed) return;
  const choice = resolveChoice(projectRoot, parsed.id, parsed.index);
  if (!choice) {
    await effects.answer("This choice is no longer available.");
    return;
  }
  if (isChoiceExpired(choice, now)) {
    await effects.answer("This choice has expired.");
    await effects.removeKeyboard();
    deleteChoice(projectRoot, choice.id);
    return;
  }
  if (String(callback.chatId) !== choice.defaultChatId) {
    await effects.answer("This choice is not for this chat.");
    return;
  }
  if (choice.answered) {
    await effects.answer("This choice was already answered.");
    return;
  }
  const option = choice.options[parsed.index];
  if (!option) {
    await effects.answer("Invalid choice.");
    return;
  }
  choice.answered = true;
  await choice.onAnswer?.(option, effects);
  await effects.answer();
}
