const quarantine = new Map<string, number>(); // ref -> expiresAt ms

export function quarantineModel(ref: string, quarantineMinutes: number): void {
  const expiresAt = Date.now() + quarantineMinutes * 60_000;
  quarantine.set(ref, expiresAt);
}
export function isQuarantined(ref: string): boolean {
  const expiresAt = quarantine.get(ref);
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    quarantine.delete(ref);
    return false;
  }
  return true;
}
export function clearQuarantine(): void { quarantine.clear(); }
export function quarantineExpiry(ref: string): number | undefined { return quarantine.get(ref); }
export function getQuarantineMap(): ReadonlyMap<string, number> { return quarantine; }
