import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface OverlayTheme {
  fg: (color: string, text: string) => string;
}

export interface BorderedPanelOptions {
  width: number;
  title: string;
  status: string;
  body: readonly string[];
  footer: string;
}

/**
 * Render the shared centered-overlay chrome used by the manager and child view.
 *
 * Keeping the frame in one place prevents the two views from slowly diverging:
 * both use the same title rail, status row, section separator, and footer rail.
 */
export function renderBorderedPanel(theme: OverlayTheme, options: BorderedPanelOptions): string[] {
  const width = Math.max(1, Math.floor(options.width));
  if (width < 6) {
    return [
      truncateToWidth(options.title, width),
      ...options.body.map((line) => truncateToWidth(line, width)),
    ].slice(0, Math.max(1, options.body.length + 1));
  }

  const innerWidth = width - 2;
  const contentWidth = width - 4;
  const border = (text: string): string => theme.fg("dim", text);
  const sanitize = (text: string): string => text.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ");
  const fit = (text: string): string => truncateToWidth(sanitize(text), contentWidth);
  const pad = (text: string): string => `${text}${" ".repeat(Math.max(0, contentWidth - visibleWidth(text)))}`;
  const row = (text: string): string => border("│") + ` ${pad(fit(text))} ` + border("│");
  const separator = (): string => border("├" + "─".repeat(innerWidth) + "┤");

  const title = truncateToWidth(` ${sanitize(options.title)} `, innerWidth);
  const titlePadding = Math.max(0, innerWidth - visibleWidth(title));
  const leftPadding = Math.floor(titlePadding / 2);
  const rightPadding = titlePadding - leftPadding;
  const lines = [
    border("╭" + "─".repeat(leftPadding)) + title + border("─".repeat(rightPadding) + "╮"),
    row(options.status),
    separator(),
  ];

  for (const line of options.body) lines.push(row(line));

  lines.push(separator(), row(options.footer), border("╰" + "─".repeat(innerWidth) + "╯"));
  return lines;
}

/**
 * Keep the panel's frame, status bar, and footer legend visible when content
 * exceeds the available height: body rows are dropped first, the chrome never
 * is. The last body line is retained so a partially visible section does not
 * vanish entirely (the body is built tail-first by the callers, so the
 * retained line is the most recent content).
 */
export function fitPanelToHeight(lines: readonly string[], height: number): string[] {
  const limit = Math.max(1, Math.floor(height));
  if (lines.length <= limit) return [...lines];
  if (limit === 1) return [lines[0] ?? ""];
  if (limit === 2) return [lines[0] ?? "", lines[lines.length - 1] ?? ""];
  if (limit === 3) return [lines[0] ?? "", lines[1] ?? "", lines[lines.length - 1] ?? ""];
  if (limit < 7) {
    return [
      ...lines.slice(0, 2),
      lines[lines.length - 2] ?? "",
      lines[lines.length - 1] ?? "",
    ].slice(0, limit);
  }
  const bodyStart = 3;
  const bodyEnd = lines.length - 3;
  const bodyCount = Math.max(1, bodyEnd - bodyStart);
  const keepBody = Math.max(1, limit - 6);
  if (keepBody >= bodyCount) return [...lines.slice(0, bodyStart + bodyCount), ...lines.slice(bodyEnd)];
  const body = lines.slice(bodyEnd - keepBody, bodyEnd);
  return [
    ...lines.slice(0, bodyStart),
    `${body[0] ?? ""}${body.length < bodyCount ? " …" : ""}`,
    ...lines.slice(bodyEnd),
  ];
}

export function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
    case "done":
      return "✓";
    case "failed":
    case "error":
      return "✗";
    case "cancelled":
    case "interrupted":
    case "stopped":
    case "aborted":
      return "■";
    case "active":
      return "●";
    default:
      return "◯";
  }
}
