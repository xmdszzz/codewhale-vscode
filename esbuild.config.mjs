import * as esbuild from "esbuild";

/** @type {esbuild.BuildOptions} */
const opts = {
  entryPoints: ["src/webview/panel/App.tsx"],
  bundle: true,
  minify: false,
  sourcemap: true,
  outfile: "out/webview.js",
  target: ["es2022"],
  format: "iife",
  external: ["vscode"],
  loader: { ".tsx": "tsx", ".ts": "ts" },
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log("[esbuild] watching...");
} else {
  await esbuild.build(opts);
  console.log("[esbuild] webview bundle built → out/webview.js");
}
