/**
 * Lossless frontmatter model editing.
 *
 * Agent files are parsed with the SDK `parseFrontmatter` (a `yaml` parse of the
 * `---`-delimited block). This module edits only the `model` key of that block
 * as text so every other key — comments, quoting, key order — is preserved
 * byte-for-byte. The Markdown body is never touched.
 *
 * The YAML block is located with the same delimiters the SDK parser uses:
 * `---\n` opens the block and a line starting with `\n---` closes it.
 */

/** Result of editing a scalar key in an agent file's frontmatter. */
export type FrontmatterKeyEdit =
  | { readonly ok: true; readonly content: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

/** Backwards-compatible alias used by the model editing helpers. */
export type FrontmatterModelEdit = FrontmatterKeyEdit;

/**
 * Locate the frontmatter block of an agent file.
 *
 * Mirrors the SDK extractor: the content must start with `---`, and the block
 * ends at the first `\n---` line. Returns the raw YAML block (without the
 * delimiters) and the body that follows (including the closing `\n---`), or
 * `undefined` when there is no frontmatter block.
 */
export function extractFrontmatterBlock(content: string): { yaml: string; body: string } | undefined {
  if (!content.startsWith("---")) return undefined;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return undefined;
  return {
    yaml: content.slice(4, endIndex),
    body: content.slice(endIndex),
  };
}

/** Normalize a scalar frontmatter value. */
export function normalizeFrontmatterValue(value: string): string {
  return value.trim();
}

/**
 * Set a scalar key in an agent file's frontmatter.
 *
 * When the key already exists its line is replaced with `key: <value>`;
 * otherwise the key is appended to the end of the YAML block. The body is
 * preserved byte-for-byte. Files without a frontmatter block are left
 * unchanged and reported as not changed.
 */
export function setFrontmatterKey(content: string, key: string, value: string): FrontmatterKeyEdit {
  const normalized = normalizeFrontmatterValue(value);
  if (!normalized) {
    return { ok: false, message: `${key} value must not be empty` };
  }
  const block = extractFrontmatterBlock(content);
  if (!block) {
    return { ok: true, content, changed: false };
  }
  const yamlLines = block.yaml.split("\n");
  const lineIndex = yamlLines.findIndex((line) => new RegExp(`^${escapeKey(key)}\s*:`).test(line));
  const replacement = `${key}: ${normalized}`;
  if (lineIndex !== -1) {
    if (yamlLines[lineIndex] === replacement) {
      return { ok: true, content, changed: false };
    }
    yamlLines[lineIndex] = replacement;
  } else {
    yamlLines.push(replacement);
  }
  return {
    ok: true,
    content: `---\n${yamlLines.join("\n")}${block.body}`,
    changed: true,
  };
}

/** Escape a frontmatter key for use in a line-matching regular expression. */
function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove a scalar key from an agent file's frontmatter.
 *
 * The matching line is removed; everything else is preserved byte-for-byte.
 * A frontmatter block without the key (or no block at all) is unchanged.
 */
export function removeFrontmatterKey(content: string, key: string): FrontmatterKeyEdit {
  const block = extractFrontmatterBlock(content);
  if (!block) return { ok: true, content, changed: false };
  const yamlLines = block.yaml.split("\n");
  const lineIndex = yamlLines.findIndex((line) => new RegExp(`^${escapeKey(key)}\s*:`).test(line));
  if (lineIndex === -1) {
    return { ok: true, content, changed: false };
  }
  yamlLines.splice(lineIndex, 1);
  return {
    ok: true,
    content: `---\n${yamlLines.join("\n")}${block.body}`,
    changed: true,
  };
}

/** Set the `model` key (alias for `setFrontmatterKey(content, "model", value)`). */
export function setFrontmatterModel(content: string, value: string): FrontmatterModelEdit {
  return setFrontmatterKey(content, "model", value);
}

/** Remove the `model` key (alias for `removeFrontmatterKey(content, "model")`). */
export function removeFrontmatterModel(content: string): FrontmatterModelEdit {
  return removeFrontmatterKey(content, "model");
}
