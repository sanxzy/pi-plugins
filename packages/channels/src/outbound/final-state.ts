const sentByTool = new Map<string, Set<string>>();

/** Record a successful explicit tool send for this active project run. */
export function recordTelegramToolSend(projectRoot: string, text: string): void {
  const sent = sentByTool.get(projectRoot) ?? new Set<string>();
  sent.add(text);
  sentByTool.set(projectRoot, sent);
}

/** Check whether the exact text was sent by the explicit Telegram tool. */
export function wasTelegramToolSend(projectRoot: string, text: string): boolean {
  return sentByTool.get(projectRoot)?.has(text) ?? false;
}

/** Clear duplicate-suppression state when the root run settles or shuts down. */
export function clearTelegramToolSends(projectRoot: string): void {
  sentByTool.delete(projectRoot);
}

/** Test-only reset for isolated project-root state. */
export function resetTelegramToolSendState(): void {
  sentByTool.clear();
}
