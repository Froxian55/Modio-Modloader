import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import yauzl from "yauzl";
import type { AppConfig, SubscribedMod } from "./types";
import { ModioClient } from "./modio";

type ProgressReporter = (message: string) => void;
const maxArchiveEntries = 100_000;
const maxFileSize = 2 * 1024 * 1024 * 1024;
const maxArchiveSize = 10 * 1024 * 1024 * 1024;

export async function syncMods(
  mods: SubscribedMod[],
  config: AppConfig,
  report: ProgressReporter,
): Promise<void> {
  const client = new ModioClient(config);
  const plan: SubscribedMod[] = [];
  const planned = new Set<string>();

  for (const mod of mods) {
    report(`Checking required mods: ${mod.gameName} / ${mod.modName}`);
    try {
      const dependencies = await client.getModDependencies(mod);
      for (const dependency of dependencies) {
        const key = `${mod.gameId}:${dependency.modId}`;
        if (planned.has(key)) continue;
        planned.add(key);
        plan.push({
          gameId: mod.gameId,
          gameName: mod.gameName,
          modId: dependency.modId,
          modName: dependency.modName,
        });
        report(`Added required mod: ${dependency.modName}`);
      }
      const key = `${mod.gameId}:${mod.modId}`;
      if (!planned.has(key)) {
        planned.add(key);
        plan.push(mod);
      }
    } catch (error) {
      report(`Skipped ${mod.modName}: could not check its required mods: ${getErrorMessage(error)}`);
    }
  }

  for (const mod of plan) {
    const mapping = config.games[mod.gameId];
    if (!mapping?.targetPath) {
      report(`Skipped ${mod.modName}: choose an install folder first.`);
      continue;
    }

    const staging = await mkdtemp(path.join(os.tmpdir(), "modio-manager-"));
    try {
      report(`Downloading (${mapping.targetPlatform}): ${mod.gameName} / ${mod.modName}`);
      const downloadUrl = await client.getDownloadUrl(mod, mapping.targetPlatform);
      const url = new URL(downloadUrl);
      if (url.protocol !== "https:") throw new Error("The mod download URL must use HTTPS.");

      const safeName = makeSafeFileName(mod.modName);
      const safeId = makeSafeFileName(mod.modId);
      const extension = path.extname(url.pathname) || ".zip";
      const archivePath = path.join(staging, `${safeName}-${safeId}${extension}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(1_800_000) });
      if (!response.ok || !response.body) {
        throw new Error(`The mod download failed: HTTP ${response.status} ${response.statusText}.`);
      }
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        createWriteStream(archivePath, { flags: "wx" }),
      );
      await mkdir(mapping.targetPath, { recursive: true });

      if (!mapping.extractArchives) {
        await copyFile(
          archivePath,
          path.join(mapping.targetPath, `${safeName}-${safeId}${extension}`),
        );
      } else {
        const extracted = path.join(staging, "extracted");
        await mkdir(extracted);
        await extractZipSafely(archivePath, extracted);
        await copyDirectoryContents(extracted, mapping.targetPath);
      }
      report(`Completed: ${mod.gameName} / ${mod.modName}`);
    } catch (error) {
      report(`Failed: ${mod.gameName} / ${mod.modName}: ${getErrorMessage(error)}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function extractZipSafely(archivePath: string, targetDirectory: string): Promise<void> {
  const root = path.resolve(targetDirectory);
  const rootPrefix = `${root}${path.sep}`;
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error("Could not open the mod archive."));
        return;
      }

      let completed = false;
      let entryCount = 0;
      let totalUncompressedSize = 0;
      const fail = (error: Error) => {
        if (completed) return;
        completed = true;
        zip.close();
        reject(error);
      };

      zip.on("error", fail);
      zip.on("end", () => {
        if (!completed) {
          completed = true;
          resolve();
        }
      });
      zip.on("entry", (entry) => {
        void (async () => {
          entryCount += 1;
          if (entryCount > maxArchiveEntries) {
            throw new Error("The ZIP archive contains too many entries.");
          }
          if (entry.uncompressedSize > maxFileSize) {
            throw new Error(`ZIP entry exceeds the per-file size limit: ${entry.fileName}`);
          }
          totalUncompressedSize += entry.uncompressedSize;
          if (totalUncompressedSize > maxArchiveSize) {
            throw new Error("The ZIP archive exceeds the total extracted size limit.");
          }

          const entryName = entry.fileName.replace(/\\/g, "/");
          const normalized = path.posix.normalize(entryName);
          const segments = normalized.split("/");
          if (
            !entryName ||
            entryName.includes("\0") ||
            path.posix.isAbsolute(entryName) ||
            path.win32.isAbsolute(entryName) ||
            normalized === ".." ||
            normalized.startsWith("../") ||
            /^[a-zA-Z]:/.test(entryName) ||
            segments.some((segment) => /[<>:"|?*\u0000-\u001f]/.test(segment))
          ) {
            throw new Error(`Unsafe path in ZIP archive: ${entry.fileName}`);
          }

          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode === 0xa000) {
            throw new Error(`Symbolic links are not allowed in archives: ${entry.fileName}`);
          }

          const destination = path.resolve(root, ...normalized.split("/"));
          if (destination !== root && !destination.startsWith(rootPrefix)) {
            throw new Error(`The archive attempts to write outside its folder: ${entry.fileName}`);
          }

          const isDirectory = entry.fileName.endsWith("/") || mode === 0x4000;
          if (isDirectory) {
            await mkdir(destination, { recursive: true });
          } else {
            await mkdir(path.dirname(destination), { recursive: true });
            const input = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
              zip.openReadStream(entry, (streamError, stream) => {
                if (streamError || !stream) rejectStream(streamError || new Error("Could not read archive entry."));
                else resolveStream(stream);
              });
            });
            await pipeline(input, createWriteStream(destination, { flags: "wx" }));
          }
          zip.readEntry();
        })().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
      });
      zip.readEntry();
    });
  });
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDirectoryContents(sourcePath, targetPath);
    } else {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

function makeSafeFileName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return safe || "mod";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
