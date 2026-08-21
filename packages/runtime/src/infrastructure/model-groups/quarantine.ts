const quarantine = new Map<string, number>(); // ref -> remaining turns

/** Quarantine a model for the given number of model hits (turns). */
export function quarantineModel(ref: string, quarantineTurns: number): void {
  const turns = Math.max(1, Math.trunc(quarantineTurns));
  quarantine.set(ref, Math.max(quarantine.get(ref) ?? 0, turns));
}
export function isQuarantined(ref: string): boolean {
  const remaining = quarantine.get(ref);
  if (remaining === undefined) return false;
  return remaining > 0;
}
/**
 * Consume one turn of every active quarantine entry. Called once per model
 * hit so quarantined members return to rotation after N subsequent hits.
 */
export function tickQuarantineTurns(): void {
  for (const [ref, remaining] of quarantine) {
    const next = remaining - 1;
    if (next <= 0) quarantine.delete(ref);
    else quarantine.set(ref, next);
  }
}
export function clearQuarantine(): void { quarantine.clear(); }
export function quarantineRemainingTurns(ref: string): number | undefined { return quarantine.get(ref); }
export function getQuarantineMap(): ReadonlyMap<string, number> { return quarantine; }
