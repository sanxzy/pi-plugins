/**
 * Structural setup-controller interface owned by the TUI package.
 *
 * `@xzy-ai/channels` returns an object that structurally satisfies this
 * interface, so the widget never imports channels or grammY. The stored token
 * is never exposed: the widget only sees a boolean `hasExistingToken` flag and
 * a masked keep/replace state.
 */
export interface TelegramSetupController {
  getState(): {
    phase: "token" | "discovery" | "review";
    hasExistingToken: boolean;
    tokenConfigured: boolean;
    maskedTokenExposed: false;
    candidates: string[];
    allowedChatIds: string[];
    defaultChatId: string | undefined;
  };
  setToken(token: string): Promise<{ ok: true } | { ok: false; error: string }>;
  keepToken(): { ok: true } | { ok: false; error: string };
  acceptDiscoveredChat(chatId: string): void;
  setAllowedChat(chatId: string, allowed: boolean): void;
  setDefaultChat(chatId: string): { ok: true } | { ok: false; error: string };
  confirm(): Promise<{ ok: true } | { ok: false; error: string }>;
  cancel(): Promise<void>;
  stopOldListener(): Promise<void>;
}