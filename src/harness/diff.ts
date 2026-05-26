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
  let currentHunk: string[] | null = null;

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
      if (currentHunk) {
        hunks.push(buildHunk(currentHunk));
      }
      currentHunk = [
        `@@ -${hunkMatch[1]},${hunkMatch[2] ?? "1"} +${hunkMatch[3]},${hunkMatch[4] ?? "1"} @@`,
      ];
      continue;
    }

    if (currentHunk) {
      if (trimmed === "" || trimmed.startsWith("\\ ")) {
        // end-of-hunk marker or empty line
        currentHunk.push(line);
      } else if (
        line.startsWith("-") ||
        line.startsWith("+") ||
        line.startsWith(" ")
      ) {
        currentHunk.push(line);
      } else if (trimmed === "") {
        currentHunk.push(line);
      }
      // Otherwise it's a summary line like "Wrote 42 bytes..." — end of diff
    }
  }

  if (currentHunk) {
    hunks.push(buildHunk(currentHunk));
  }

  const resolvedPath = newPath || oldPath;
  if (!resolvedPath || hunks.length === 0) return null;

  return { oldPath: oldPath || resolvedPath, newPath: resolvedPath, hunks };
}

function buildHunk(lines: string[]): ParsedHunk {
  const header = lines[0];
  const match = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  const oldStart = match ? Number(match[1]) : 1;
  const oldCount = match ? Number(match[2] ?? "1") : 1;
  const newStart = match ? Number(match[3]) : 1;
  const newCount = match ? Number(match[4] ?? "1") : 1;

  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    lines: lines.slice(1), // skip header
  };
}

/**
 * Given the new content and a unified diff, reconstruct the old content
 * by applying the hunks in reverse.
 */
export function reverseApply(newContent: string, diff: ParsedDiff): string {
  const newLines = newContent.split("\n");
  // Process hunks in reverse order to preserve line numbers
  const sorted = [...diff.hunks].sort((a, b) => b.newStart - a.newStart);

  for (const hunk of sorted) {
    const result: string[] = [];
    let newIdx = 0; // index in newLines (0-based)
    const targetNewStart = hunk.newStart - 1; // 0-based

    // Copy lines before this hunk
    while (newIdx < targetNewStart && newIdx < newLines.length) {
      result.push(newLines[newIdx]);
      newIdx++;
    }

    // Process hunk: skip '+' lines (new-only), add '-' lines (old-only),
    // keep context lines (prefixed with " ")
    let hunkNewOffset = 0;
    for (const hunkLine of hunk.lines) {
      const prefix = hunkLine[0];
      const content = hunkLine.slice(1);

      if (prefix === "+") {
        // Added in new version — skip in old
        newIdx++; // consume from newLines
        hunkNewOffset++;
      } else if (prefix === "-") {
        // Removed in new version — restore in old
        result.push(content);
      } else if (prefix === " ") {
        // Context line — present in both
        result.push(content);
        newIdx++;
        hunkNewOffset++;
      }
      // Ignore other prefixes (empty lines, "\ No newline", etc.)
    }

    // Copy remaining lines after this hunk
    while (newIdx < newLines.length) {
      result.push(newLines[newIdx]);
      newIdx++;
    }

    newLines.length = 0;
    newLines.push(...result);
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
