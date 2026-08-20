/**
 * Host-level swap primitive for F009.
 *
 * This module simulates the host's native swap API that rebinds the main
 * window to a child session. The real host patch exposes the same contract
 * via AgentSession._hostSwapStack; this runtime wrapper models it as a pure
 * state machine so it can be unit-tested with fake hosts and used by the
 * extension's footer without depending on the actual TUI.
 *
 * Contract:
 *  - isSwapped() false at parent, true while viewing child
 *  - current() always points at the visible session (parent when not swapped, child when swapped)
 *  - swapTo(child) pushes parent onto stack and rebinds to child; preserves parent's editorText/scroll
 *  - restore() pops stack, restores parent's preserved state, and returns it
 *  - Parent background output is buffered while swapped and only revealed after restore
 *  - Stack is unbounded (parent → child → grandchild)
 */

export interface HostSwapTarget {
  sessionFile: string;
  sessionId: string;
  editorText: string;
  scrollOffset: number;
}

export interface BufferedOutput {
  text: string;
}

export interface HostSwapController {
  isSwapped(): boolean;
  current(): HostSwapTarget;
  getStackDepth(): number;
  swapTo(target: HostSwapTarget): void;
  restore(): HostSwapTarget | undefined;
  bufferParentOutput(entry: BufferedOutput): void;
  drainBufferedParentOutput(): BufferedOutput[];
}

export function createHostSwapController(initial: HostSwapTarget): HostSwapController {
  const stack: HostSwapTarget[] = [];
  let current: HostSwapTarget = { ...initial };
  let swapped = false;
  const buffered: BufferedOutput[] = [];

  return {
    isSwapped: () => swapped,
    current: () => ({ ...current }),
    getStackDepth: () => stack.length,
    swapTo(target: HostSwapTarget): void {
      // Push current (parent or current child) onto stack and rebind to target
      stack.push({ ...current });
      current = { ...target };
      swapped = true;
      // While swapped, parent background output is buffered, not shown via current()
    },
    restore(): HostSwapTarget | undefined {
      if (stack.length === 0) return undefined;
      const prev = stack.pop()!;
      current = { ...prev };
      swapped = stack.length > 0;
      return { ...prev };
    },
    bufferParentOutput(entry: BufferedOutput): void {
      // Only buffer while swapped; parent output is hidden until return.
      // When not swapped the parent is the visible session, so its output is
      // already shown directly and there is nothing to queue.
      if (swapped) {
        buffered.push({ ...entry });
      }
    },
    drainBufferedParentOutput(): BufferedOutput[] {
      const out = buffered.splice(0, buffered.length);
      return out;
    },
  };
}
