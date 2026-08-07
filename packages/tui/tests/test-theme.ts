import type { EditorTheme } from "@earendil-works/pi-tui";

/**
 * Stub theme for dialog tests: every theme function is the identity function
 * so rendered lines stay plain text that assertions can match on.
 */

export const textTheme: EditorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
