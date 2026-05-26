import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Auto-download codewhale-tui from GitHub Releases.
 *
 * Lifecycle:
 *   1. Check if binary already exists at storagePath
 *   2. If not, fetch release assets list from GitHub API
 *   3. Download the platform-appropriate binary
 *   4. Verify SHA256 checksum against the release's checksum file
 *   5. Make executable (chmod on Unix)
 *   6. Emit "done" with the binary path
 */

const RELEASE_REPO = "Hmbown/CodeWhale";
const ASSET_NAME = assetNameForPlatform();
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_BASE_MS = 1000;
const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_BASE_MS = 500;

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

export class BinaryDownloader extends EventEmitter {
  constructor(
    private readonly storagePath: string,
    private readonly version: string
  ) {
    super();
  }

  /** Full path to the installed binary. */
  get binaryPath(): string {
    return path.join(
      this.storagePath,
      `codewhale-tui-${this.version}${os.platform() === "win32" ? ".exe" : ""}`
    );
  }

  /** True if the binary is already installed. */
  isInstalled(): boolean {
    return fs.existsSync(this.binaryPath);
  }

  /**
   * Ensure the binary is installed. Downloads if missing.
   * Emits "progress" events: { phase, current?, total? }
   */
  async ensure(): Promise<string> {
    if (this.isInstalled()) {
      this.emit("progress", { phase: "already_installed" });
      return this.binaryPath;
    }

    this.emit("progress", { phase: "fetching_release" });

    // 1. Fetch release metadata (with retry)
    const release = await withRetry(() => this._fetchRelease(), FETCH_MAX_RETRIES, FETCH_RETRY_BASE_MS, "fetch");

    // 2. Find the asset for this platform
    const asset = release.assets.find((a) => a.name === ASSET_NAME);
    if (!asset) {
      const available = release.assets.map((a) => a.name).join(", ");
      throw new Error(
        `No binary found for platform "${ASSET_NAME}". Available assets: ${available}`
      );
    }

    // 3. Find checksum file
    const checksumAsset = release.assets.find(
      (a) =>
        a.name === "codewhale-artifacts-sha256.txt" ||
        a.name === "deepseek-artifacts-sha256.txt"
    );

    // 4. Download binary (with retry)
    this.emit("progress", {
      phase: "downloading",
      current: 0,
      total: asset.size,
    });

    const tmpPath = this.binaryPath + ".download";
    await withRetry(
      () => this._downloadFile(asset.browser_download_url, tmpPath, asset.size),
      DOWNLOAD_MAX_RETRIES,
      DOWNLOAD_RETRY_BASE_MS,
      "download"
    );

    // 5. Verify checksum
    if (checksumAsset) {
      this.emit("progress", { phase: "verifying" });
      const isValid = await this._verifyChecksum(
        tmpPath,
        checksumAsset.browser_download_url,
        ASSET_NAME
      );
      if (!isValid) {
        cleanTemp(tmpPath);
        throw new Error("Checksum verification failed for downloaded binary");
      }
    }

    // 6. Rename and make executable
    fs.renameSync(tmpPath, this.binaryPath);
    if (os.platform() !== "win32") {
      fs.chmodSync(this.binaryPath, 0o755);
    }

    this.emit("progress", { phase: "done" });
    return this.binaryPath;
  }

  // ── Private helpers ──────────────────────────────────────

  private _fetchRelease(): Promise<GithubRelease> {
    return this._httpsJson(
      `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${this.version}`,
      { "User-Agent": "codewhale-vscode" }
    );
  }

  private _downloadFile(
    url: string,
    dest: string,
    totalSize: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure parent directory exists before creating the write stream
      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = fs.createWriteStream(dest);
      let downloaded = 0;

      // Catch write-stream errors (disk full, permission denied, etc.)
      file.on("error", (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch { /* best-effort */ }
        reject(err);
      });

      const get = url.startsWith("https") ? https.get : http.get;
      const req = get(
        url,
        { headers: { "User-Agent": "codewhale-vscode" } },
        (res) => {
          // Handle redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            try { fs.unlinkSync(dest); } catch { /* best-effort */ }
            this._downloadFile(res.headers.location, dest, totalSize).then(resolve, reject);
            return;
          }

          if (res.statusCode !== 200) {
            file.close();
            try { fs.unlinkSync(dest); } catch { /* best-effort */ }
            reject(
              new Error(`Download failed with status ${res.statusCode}`)
            );
            return;
          }

          const write = (chunk: Buffer): void => {
            downloaded += chunk.length;
            const ok = file.write(chunk);
            this.emit("progress", {
              phase: "downloading",
              current: downloaded,
              total: totalSize,
            });
            if (!ok) {
              // Back-pressure: pause reading until the stream drains
              res.pause();
              file.once("drain", () => res.resume());
            }
          };

          res.on("data", write);

          res.on("end", () => {
            file.end(() => resolve());
          });

          res.on("error", (err) => {
            file.close();
            try { fs.unlinkSync(dest); } catch { /* best-effort */ }
            reject(err);
          });
        }
      );

      req.on("error", (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch { /* best-effort */ }
        reject(err);
      });

      req.setTimeout(120_000, () => {
        req.destroy(new Error("Download timeout"));
      });
    });
  }

  private async _verifyChecksum(
    filePath: string,
    checksumUrl: string,
    assetName: string
  ): Promise<boolean> {
    try {
      const checksumText = await this._httpsText(checksumUrl, {
        "User-Agent": "codewhale-vscode",
      });
      const expected = this._parseChecksum(checksumText, assetName);
      if (!expected) return false;

      const actual = await this._sha256File(filePath);
      return (
        crypto.timingSafeEqual(
          Buffer.from(expected, "hex"),
          Buffer.from(actual, "hex")
        ) && expected === actual
      );
    } catch {
      // If checksum verification fails for network reasons, skip it
      // but warn — the binary will still be installed
      this.emit("progress", { phase: "checksum_skipped" });
      return true;
    }
  }

  private _parseChecksum(
    text: string,
    assetName: string
  ): string | null {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.endsWith(assetName) || trimmed.endsWith(`  ${assetName}`)) {
        const parts = trimmed.split(/\s+/);
        return parts[0] ?? null;
      }
    }
    return null;
  }

  private _sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => { hash.update(chunk); });
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  private _httpsJson(
    url: string,
    headers: Record<string, string>
  ): Promise<any> {
    return this._httpsText(url, headers).then(
      (text) => JSON.parse(text),
      (err) => {
        throw new Error(
          `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );
  }

  private _httpsText(
    url: string,
    headers: Record<string, string>
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const get = url.startsWith("https") ? https.get : http.get;
      const req = get(url, { headers }, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._httpsText(res.headers.location, headers).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(30_000, () =>
        req.destroy(new Error("Request timeout"))
      );
    });
  }
}

// ── Utilities ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseMs: number,
  label?: string
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const tag = label ? `[codewhale:${label}]` : "[codewhale:retry]";
      console.error(`${tag} attempt ${attempt + 1}/${maxRetries + 1} failed:`, lastErr.message);
      if (attempt === maxRetries) break;
      const delay = baseMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastErr ?? new Error("Retry failed");
}

function cleanTemp(tmpPath: string): void {
  try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
}

/** Asset name for the current platform (matches GitHub release naming). */
function assetNameForPlatform(): string {
  const plat = os.platform();
  const arch = os.arch();
  const osName =
    plat === "win32" ? "windows" : plat === "darwin" ? "macos" : "linux";
  const archName = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : "x64";
  const ext = plat === "win32" ? ".exe" : "";
  return `codewhale-tui-${osName}-${archName}${ext}`;
}
