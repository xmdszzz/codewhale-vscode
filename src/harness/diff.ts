/**
 * Unified-diff parser and reverse applicator.
 *
 * Takes the raw unified diff string emitted in TurnItemRecord.detail
 * (kind: "file_change") and extracts file paths plus reconstructed
 * old/new content suitable for VSCode's built-in diff editor.
 */

export interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // includes prefix: "-" | "+" | " "
}

export interface ParsedDiff {
  oldPath: string;
  newPath: string;
  hunks: ParsedHunk[];
}

export interface DiffContent {
  oldContent: string;
  newContent: string;
  filePath: string;
}

/**
 * Parse a unified diff string into structured data.
 */
export function parseUnifiedDiff(text: string): ParsedDiff | null {
  const lines = text.split("\n");
  let oldPath = "";
  let newPath = "";
  const hunks: ParsedHunk[] = [];
  let current: { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.startsWith("--- a/") || line.startsWith("--- ")) {
      oldPath = line.replace(/^--- (a\/)?/, "").trim();
      continue;
    }
    if (line.startsWith("+++ b/") || line.startsWith("+++ ")) {
      newPath = line.replace(/^\+\+\+ (b\/)?/, "").trim();
      continue;
    }

    const hunkMatch = trimmed.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    );
    if (hunkMatch) {
      if (current) {
        hunks.push({
          oldStart: current.oldStart,
          oldCount: current.oldCount,
          newStart: current.newStart,
          newCount: current.newCount,
          lines: current.lines,
        });
      }
      current = {
        header: `@@ -${hunkMatch[1]},${hunkMatch[2] ?? "1"} +${hunkMatch[3]},${hunkMatch[4] ?? "1"} @@`,
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        lines: [],
      };
      continue;
    }

    if (current) {
      if (trimmed === "" || trimmed.startsWith("\\ ")) {
        current.lines.push(line);
      } else if (
        line.startsWith("-") ||
        line.startsWith("+") ||
        line.startsWith(" ")
      ) {
        current.lines.push(line);
      }
    }
  }

  if (current) {
    hunks.push({
      oldStart: current.oldStart,
      oldCount: current.oldCount,
      newStart: current.newStart,
      newCount: current.newCount,
      lines: current.lines,
    });
  }

  const resolvedPath = newPath || oldPath;
  if (!resolvedPath || hunks.length === 0) return null;

  return { oldPath: oldPath || resolvedPath, newPath: resolvedPath, hunks };
}

/**
 * Given the new content and a unified diff, reconstruct the old content
 * by applying the hunks in reverse (bottom-up to preserve line numbers).
 */
export function reverseApply(newContent: string, diff: ParsedDiff): string {
  const newLines = newContent.split("\n");
  // Process hunks bottom-up so line numbers earlier in the file stay valid
  const sorted = [...diff.hunks].sort((a, b) => b.newStart - a.newStart);

  for (const hunk of sorted) {
    const startIdx = hunk.newStart - 1; // 0-based
    let newConsumed = 0; // how many lines of newLines this hunk consumes
    const kept: string[] = []; // lines to keep in the old content

    for (const hunkLine of hunk.lines) {
      const prefix = hunkLine[0];
      const content = hunkLine.slice(1);

      if (prefix === "+") {
        newConsumed++; // added line, not in old
      } else if (prefix === "-") {
        kept.push(content); // deleted line, restore in old
      } else if (prefix === " ") {
        kept.push(content); // context line, keep
        newConsumed++;
      }
    }

    // Replace the hunk segment in-place
    newLines.splice(startIdx, newConsumed, ...kept);
  }

  return newLines.join("\n");
}

/**
 * Extract the file path from a unified diff and determine what content
 * to show in VSCode's diff editor.
 *
 * - `filePath` comes from the `+++ b/...` header
 * - `oldContent` is reconstructed by reverse-applying the diff to newContent
 * - `newContent` is the current file state after the tool ran
 */
export function prepareDiffPreview(
  diffText: string,
  newContent: string
): DiffContent | null {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed) return null;

  const oldContent = reverseApply(newContent, parsed);
  return {
    oldContent,
    newContent,
    filePath: parsed.newPath,
  };
}
