import { app, safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, GameMapping } from "./types";

const configDirectory = path.join(
  process.env.LOCALAPPDATA || app.getPath("userData"),
  "ModioManager",
);
const configPath = path.join(configDirectory, "modio_config.electron.json");
const legacyPath = path.join(configDirectory, "modio_config.json");

interface StoredConfig {
  version: 1;
  encryptedApiKey: string;
  encryptedAccessToken: string;
  userId: string;
  games: Record<string, GameMapping>;
}

export async function loadConfig(): Promise<{ config: AppConfig; migrationMessage?: string }> {
  await mkdir(configDirectory, { recursive: true });
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8")) as StoredConfig;
    if (stored.version !== 1 || !await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error("Secure local credential storage is unavailable or settings are invalid.");
    }

    const [apiKey, accessToken] = await Promise.all([
      decryptSecret(stored.encryptedApiKey),
      decryptSecret(stored.encryptedAccessToken),
    ]);
    const config: AppConfig = {
      apiKey: apiKey.value,
      accessToken: accessToken.value,
      userId: stored.userId || "",
      games: normalizeGames(stored.games),
    };
    if (apiKey.shouldReEncrypt || accessToken.shouldReEncrypt) {
      await saveConfig(config);
    }
    return { config };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (await fileExists(configPath)) {
        throw new Error(`Could not read the encrypted settings file: ${getErrorMessage(error)}`);
      }
    }
  }

  const config: AppConfig = { apiKey: "", accessToken: "", userId: "", games: {} };
  try {
    const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as Record<string, unknown>;
    config.userId = String(legacy.userId ?? legacy.UserId ?? "");
    const legacyGames = legacy.games ?? legacy.Games;
    config.games = normalizeLegacyGames(legacyGames);
    if (Object.keys(config.games).length > 0 || config.userId) {
      return {
        config,
        migrationMessage:
          "Your previous game folders were imported. Enter your API key once to finish moving settings to Electron's secure storage.",
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && await fileExists(legacyPath)) {
      throw new Error(`Could not read the previous settings file: ${getErrorMessage(error)}`);
    }
  }

  return { config };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error("Windows secure credential storage is unavailable. The API key was not saved.");
  }

  await mkdir(configDirectory, { recursive: true });
  const stored: StoredConfig = {
    version: 1,
    encryptedApiKey: (await safeStorage.encryptStringAsync(config.apiKey)).toString("base64"),
    encryptedAccessToken: (await safeStorage.encryptStringAsync(config.accessToken)).toString("base64"),
    userId: config.userId,
    games: config.games,
  };
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(stored, null, 2), { encoding: "utf8" });
  const { rename } = await import("node:fs/promises");
  await rename(temporaryPath, configPath);
}

export function getConfigPath(): string {
  return configPath;
}

async function decryptSecret(value: string): Promise<{ value: string; shouldReEncrypt: boolean }> {
  if (!value) return { value: "", shouldReEncrypt: false };
  const encrypted = Buffer.from(value, "base64");
  const decrypted = await safeStorage.decryptStringAsync(encrypted);
  if (decrypted.shouldReEncrypt) {
    const refreshed = await safeStorage.decryptStringAsync(encrypted);
    return { value: refreshed.result, shouldReEncrypt: true };
  }
  return { value: decrypted.result, shouldReEncrypt: false };
}

function normalizeGames(games?: Record<string, GameMapping>): Record<string, GameMapping> {
  if (!games || typeof games !== "object") return {};
  return Object.fromEntries(
    Object.entries(games).map(([id, mapping]) => [
      id,
      {
        gameName: mapping?.gameName || `Game ${id}`,
        targetPath: mapping?.targetPath || "",
        extractArchives: mapping?.extractArchives !== false,
        targetPlatform: mapping?.targetPlatform === "android" ? "android" : "windows",
      },
    ]),
  );
}

function normalizeLegacyGames(value: unknown): Record<string, GameMapping> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(entries.map(([id, raw]) => {
    const mapping = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return [id, {
      gameName: String(mapping.gameName ?? mapping.GameName ?? `Game ${id}`),
      targetPath: String(mapping.targetPath ?? mapping.TargetPath ?? ""),
      extractArchives: (mapping.extractArchives ?? mapping.ExtractArchives) !== false,
      targetPlatform: (mapping.targetPlatform ?? mapping.TargetPlatform) === "android" ? "android" : "windows",
    }];
  }));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
