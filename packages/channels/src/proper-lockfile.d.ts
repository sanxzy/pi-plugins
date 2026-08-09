declare module "proper-lockfile" {
  interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | Record<string, unknown>;
    realpath?: boolean;
    lockfilePath?: string;
    onCompromised?: (error: Error) => void;
  }

  type Release = () => void;

  const lockfile: {
    lockSync(file: string, options?: LockOptions): Release;
    unlockSync(file: string, options?: LockOptions): void;
    lock(file: string, options?: LockOptions): Promise<Release>;
    unlock(file: string, options?: LockOptions): Promise<void>;
    check(file: string, options?: LockOptions): Promise<boolean>;
    checkSync(file: string, options?: LockOptions): boolean;
  };

  export default lockfile;
}