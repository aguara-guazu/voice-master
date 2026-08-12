import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = "aguara-guazu/voice-master";

// GitHub replaces the spaces of an asset name with dots, so the "Voice Master"
// product name arrives as "Voice.Master". Verified against the published
// release: the space-encoded form 404s.
const assetName = (): string => `Voice.Master-${process.arch}.dmg`;

// The self-install path is implemented for the macOS disk image only. On other
// platforms the release page is offered instead.
export const canSelfInstall = process.platform === "darwin";
export const releasesPage = `https://github.com/${REPO}/releases/latest`;

const CHECK_TIMEOUT_MS = 6000;

// The models travel inside the image, so a build is around 680 MB. Anything far
// below that is an error page or a truncated transfer, not an application.
const MIN_DMG_BYTES = 300 * 1024 * 1024;

export interface ReleaseInfo {
  version: string;
  notes: string;
  downloadUrl: string | null;
}

const parseVersion = (value: string): number[] =>
  value
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** Positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Returns null on any failure: a missing update must never block startup. */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const release = (await response.json()) as {
      tag_name?: string;
      body?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    if (!release.tag_name) return null;

    const asset = canSelfInstall
      ? (release.assets ?? []).find((entry) => entry.name === assetName())
      : undefined;

    return {
      version: release.tag_name.replace(/^v/, ""),
      notes: release.body?.trim() ?? "",
      downloadUrl: asset?.browser_download_url ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Downloads over HTTPS from Node, which — unlike a browser download — does not
 * tag the file with com.apple.quarantine. That is what lets an unsigned,
 * un-notarized build update itself without Gatekeeper refusing to launch the
 * result.
 */
export async function downloadUpdate(
  url: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-master-update-"));
  const target = path.join(directory, assetName());

  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) {
    throw new Error(`the download answered ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) onProgress(Math.min(1, received / total));
  });

  await pipeline(source, createWriteStream(target));

  const written = await stat(target);
  if (written.size < MIN_DMG_BYTES) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("the downloaded file is too small to be a build");
  }
  return target;
}

// fs.rm cannot always finish off a bundle whose binary is mapped by a running
// process — it leaves a skeleton behind — so removals go through /bin/rm.
const removeTree = (target: string) => run("/bin/rm", ["-rf", target]).catch(() => undefined);

/** Removes staging and backup bundles left behind by an earlier update. */
export async function cleanupLeftovers(bundlePath: string): Promise<void> {
  await removeTree(`${bundlePath}.previous`);
  await removeTree(`${bundlePath}.incoming`);
}

/**
 * Mounts the image, stages the new bundle beside the current one and swaps it in
 * a single move, so a failed copy can never leave a half-written application
 * behind. The old bundle is moved aside rather than deleted: if the swap fails
 * it is moved back, instead of leaving no application at all.
 */
export async function installUpdate(
  dmgPath: string,
  bundlePath: string,
  expectedBundleId: string,
): Promise<void> {
  const mountPoint = await mkdtemp(path.join(tmpdir(), "voice-master-mount-"));
  try {
    await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath]);

    const { stdout } = await run("/bin/ls", [mountPoint]);
    const appName = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.endsWith(".app"));
    if (!appName) throw new Error("no application bundle inside the disk image");

    const source = path.join(mountPoint, appName);

    // Guards against installing something else entirely if the asset name ever
    // points at a different project's build.
    const plist = await readFile(path.join(source, "Contents", "Info.plist"), "utf8");
    if (!plist.includes(expectedBundleId)) {
      throw new Error("the disk image does not contain this application");
    }

    const staged = `${bundlePath}.incoming`;
    const backup = `${bundlePath}.previous`;
    await removeTree(staged);
    await removeTree(backup);

    await run("ditto", [source, staged]);
    await run("xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => undefined);

    await run("/bin/mv", [bundlePath, backup]);
    try {
      await run("/bin/mv", [staged, bundlePath]);
    } catch (error) {
      await run("/bin/mv", [backup, bundlePath]).catch(() => undefined);
      throw error;
    }

    // The backup is the bundle this process is executing from, so macOS can
    // refuse to delete parts of it. Failing to remove it must never fail the
    // update: cleanupLeftovers takes it out on the next launch.
    await removeTree(backup);
  } finally {
    await run("hdiutil", ["detach", mountPoint, "-force"]).catch(() => undefined);
    await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
    await rm(path.dirname(dmgPath), { recursive: true, force: true }).catch(() => undefined);
  }
}
