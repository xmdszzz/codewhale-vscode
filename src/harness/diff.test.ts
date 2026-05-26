import * as assert from "node:assert";
import { parseUnifiedDiff, reverseApply, prepareDiffPreview } from "./diff";

// ── parseUnifiedDiff ────────────────────────────────────────

function testParseSimple() {
  const diff = `--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,3 +1,3 @@
 function greet() {
-  return "hello";
+  return "你好";
 }`;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed, "should parse a simple diff");
  assert.strictEqual(parsed.newPath, "src/hello.ts");
  assert.strictEqual(parsed.hunks.length, 1);
  assert.strictEqual(parsed.hunks[0].oldStart, 1);
  assert.strictEqual(parsed.hunks[0].newStart, 1);
  assert.strictEqual(parsed.hunks[0].lines.length, 4);
}

function testParseMultipleHunks() {
  const diff = `--- a/foo.rs
+++ b/foo.rs
@@ -5,3 +5,3 @@
 fn bar() {
-    old_code();
+    new_code();
 }
@@ -15,2 +15,3 @@
 fn baz() {
+    added_line();
 }
`;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);
  assert.strictEqual(parsed.hunks.length, 2);
}

function testParseNonDiff() {
  const text = "Wrote 42 bytes to src/hello.ts\n(no changes)";
  const parsed = parseUnifiedDiff(text);
  assert.strictEqual(parsed, null, "non-diff text should return null");
}

function testParseWindowsPath() {
  const diff = `--- a/src\\components\\App.tsx
+++ b/src\\components\\App.tsx
@@ -1,1 +1,1 @@
-old
+new`;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);
  assert.ok(parsed.newPath.includes("components"), "should preserve path");
}

// ── reverseApply ────────────────────────────────────────────

function testReverseApplySimple() {
  const diff = `--- a/hello.ts
+++ b/hello.ts
@@ -1,3 +1,3 @@
 function greet() {
-  return "hello";
+  return "你好";
 }`;

  const newContent = `function greet() {
  return "你好";
}`;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);

  const oldContent = reverseApply(newContent, parsed);
  assert.ok(oldContent.includes('return "hello"'), "should restore old line");
  assert.ok(!oldContent.includes("你好"), "should remove new line");
}

function testReverseApplyMultiHunk() {
  const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,2 @@
 line1
-line2
 line3
@@ -10,2 +9,3 @@
 line10
 line11
+line12`;

  // newContent has 8 lines before hunk 2 position (matching @@ +9,3)
  const newContent = `line1
line3
A
B
C
D
E
F
line10
line11
line12`;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);
  assert.strictEqual(parsed.hunks.length, 2);

  const oldContent = reverseApply(newContent, parsed);
  assert.ok(oldContent.includes("line2"), "should restore removed line");
  assert.ok(!oldContent.includes("line12"), "should remove added line");
}

function testReverseApplyAddOnly() {
  const diff = `--- a/new_file.ts
+++ b/new_file.ts
@@ -1,0 +1,1 @@
+new line`;

  const newContent = `new line`;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);

  const oldContent = reverseApply(newContent, parsed);
  assert.strictEqual(oldContent, "", "old should be empty for add-only hunk");
}

function testReverseApplyDeleteOnly() {
  const diff = `--- a/old_file.ts
+++ b/old_file.ts
@@ -1,1 +1,0 @@
-deleted line`;

  const newContent = ``;

  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);

  const oldContent = reverseApply(newContent, parsed);
  assert.strictEqual(oldContent.trim(), "deleted line", "should restore deleted line");
}

// ── prepareDiffPreview ──────────────────────────────────────

function testPrepareDiffPreviewFull() {
  const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 42;
 const z = 3;`;

  const newContent = `const x = 1;
const y = 42;
const z = 3;`;

  const preview = prepareDiffPreview(diff, newContent);
  assert.ok(preview);
  assert.strictEqual(preview.filePath, "src/foo.ts");
  assert.ok(preview.oldContent.includes("const y = 2;"), "old should have y=2");
  assert.ok(preview.newContent.includes("const y = 42;"), "new should have y=42");
}

// ── Runner ──────────────────────────────────────────────────

const tests: [string, () => void][] = [
  ["parseUnifiedDiff - simple", testParseSimple],
  ["parseUnifiedDiff - multiple hunks", testParseMultipleHunks],
  ["parseUnifiedDiff - non-diff returns null", testParseNonDiff],
  ["parseUnifiedDiff - Windows paths", testParseWindowsPath],
  ["reverseApply - simple replace", testReverseApplySimple],
  ["reverseApply - multi-hunk", testReverseApplyMultiHunk],
  ["reverseApply - add only", testReverseApplyAddOnly],
  ["reverseApply - delete only", testReverseApplyDeleteOnly],
  ["prepareDiffPreview - full pipeline", testPrepareDiffPreviewFull],
];

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
