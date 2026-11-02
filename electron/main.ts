import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { autoUpdater } from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import path from "node:path";
import { loadConfig, getConfigPath, saveConfig } from "./config";
import { ModioClient } from "./modio";
import { syncMods } from "./sync";
import type {
  AppUpdateState,
  AppConfig,
  GameMapping,
  GameSettingsInput,
  ModSortField,
  Platform,
  PublicAppState,
  SortDirection,
  SubscribedGame,
  SubscribedMod,
} from "./types";

app.setName("ModioManager");

let mainWindow: BrowserWindow | null = null;
let config: AppConfig = { apiKey: "", userId: "", accessToken: "", games: {} };
let subscriptions: SubscribedMod[] = [];
let startupMessage: string | undefined;
let syncRunning = false;
let updateState: AppUpdateState = { status: "idle" };

function setUpdateState(next: AppUpdateState): void {
  updateState = next;
  mainWindow?.webContents.send("updates:state", next);
}

function formatReleaseNotes(info: UpdateInfo): string {
  if (typeof info.releaseNotes === "string") return info.releaseNotes;
  if (!Array.isArray(info.releaseNotes)) return "";
  return info.releaseNotes
    .map((item) => item.note)
    .filter((note): note is string => Boolean(note))
    .join("\n\n");
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking" }));
  autoUpdater.on("update-available", (info) => setUpdateState({
    status: "available",
    version: info.version,
    releaseNotes: formatReleaseNotes(info),
  }));
  autoUpdater.on("update-not-available", () => setUpdateState({ status: "not-available" }));
  autoUpdater.on("download-progress", (progress: ProgressInfo) => setUpdateState({
    status: "downloading",
    version: updateState.version,
    releaseNotes: updateState.releaseNotes,
    percent: progress.percent,
  }));
  autoUpdater.on("update-downloaded", (info) => setUpdateState({
    status: "downloaded",
    version: info.version,
    releaseNotes: formatReleaseNotes(info),
  }));
  autoUpdater.on("error", (error) => setUpdateState({
    status: "error",
    version: updateState.version,
    releaseNotes: updateState.releaseNotes,
    message: error.message,
  }));

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    setUpdateState({
      status: "error",
      message: getErrorMessage(error),
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1120,
    minHeight: 740,
    show: false,
    frame: false,
    backgroundColor: "#0b1020",
    title: "Modio Manager",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = app.isPackaged
      ? url.startsWith("file://")
      : url.startsWith("http://127.0.0.1:5173/");
    if (!allowed) event.preventDefault();
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  } else {
    void mainWindow.loadURL("http://127.0.0.1:5173/");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function registerHandlers(): void {
  ipcMain.handle("updates:get-state", () => updateState);

  ipcMain.handle("updates:download", async () => {
    if (updateState.status !== "available" && !(updateState.status === "error" && updateState.version)) {
      throw new Error("There is no available update to download.");
    }
    setUpdateState({
      status: "downloading",
      version: updateState.version,
      releaseNotes: updateState.releaseNotes,
      percent: 0,
    });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      setUpdateState({
        status: "error",
        version: updateState.version,
        releaseNotes: updateState.releaseNotes,
        message: getErrorMessage(error),
      });
      throw error;
    }
  });

  ipcMain.on("updates:install", () => {
    if (updateState.status !== "downloaded") return;
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("app:initial-state", async () => {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      startupMessage = "Secure Windows credential storage is unavailable. Credentials will not be saved.";
    }

    try {
      const loaded = await loadConfig();
      config = loaded.config;
      startupMessage = loaded.migrationMessage || startupMessage;
      if (config.apiKey && config.userId && config.accessToken) {
        try {
          subscriptions = await new ModioClient(config).getSubscriptions();
          await hydrateGameArtwork();
        } catch (error) {
          config.accessToken = "";
          await saveConfig(config);
          startupMessage = `Saved sign-in could not be verified. Sign in again. ${getErrorMessage(error)}`;
        }
      }
    } catch (error) {
      startupMessage = getErrorMessage(error);
    }
    return getPublicState(startupMessage);
  });

  ipcMain.handle("auth:request-code", async (_event, input: { apiKey: string; userId: string; email: string }) => {
    const apiKey = requireString(input?.apiKey || config.apiKey, "API key");
    const userId = requireString(input?.userId || config.userId, "User ID");
    const email = requireString(input?.email, "Email");
    if (!/^\d+$/.test(userId)) throw new Error("Enter the numeric mod.io User ID from your profile.");
    if (!email.includes("@")) throw new Error("Enter a valid email address.");
    const candidate: AppConfig = { ...config, apiKey, userId, accessToken: "" };
    await new ModioClient(candidate).requestLoginCode(email);
    config = candidate;
    await saveConfig(config);
  });

  ipcMain.handle("auth:verify-code", async (_event, rawCode: unknown) => {
    const code = requireString(rawCode, "Security code");
    config.accessToken = await new ModioClient(config).exchangeLoginCode(code);
    await saveConfig(config);
    startupMessage = undefined;
    subscriptions = await new ModioClient(config).getSubscriptions();
    await hydrateGameArtwork();
    return getPublicState(startupMessage || "Signed in and subscriptions loaded.");
  });

  ipcMain.handle("subscriptions:refresh", async () => {
    requireSignedIn();
    startupMessage = undefined;
    subscriptions = await new ModioClient(config).getSubscriptions();
    await hydrateGameArtwork();
    return getPublicState(startupMessage || "Subscriptions refreshed.");
  });

  ipcMain.handle("auth:logout", async () => {
    config.accessToken = "";
    subscriptions = [];
    await saveConfig(config);
    return getPublicState("Signed out. Saved game folders were kept.");
  });

  ipcMain.handle("catalog:games", async (_event, input: { query: string; offset: number; limit: number }) => {
    return new ModioClient(config).getGames(
      requireString(input?.query ?? "", "Search query"),
      requireInteger(input?.offset, "Offset"),
      clampLimit(input?.limit),
    );
  });

  ipcMain.handle("catalog:mods", async (_event, input: {
    gameId: string;
    query: string;
    offset: number;
    limit: number;
    sortField: string;
    sortDirection: string;
    tagFilters: unknown;
  }) => {
    const gameId = requireString(input?.gameId, "Game ID");
    const mods = await new ModioClient(config).getMods(
      gameId,
      requireString(input?.query ?? "", "Search query"),
      requireInteger(input?.offset, "Offset"),
      clampLimit(input?.limit),
      requireModSortField(input?.sortField),
      requireSortDirection(input?.sortDirection),
      requireTagFilters(input?.tagFilters),
    );
    const subscribed = new Set(subscriptions.map((mod) => `${mod.gameId}:${mod.modId}`));
    return mods.map((mod) => ({ ...mod, isSubscribed: subscribed.has(`${mod.gameId}:${mod.id}`) }));
  });

  ipcMain.handle("catalog:tag-groups", async (_event, rawGameId: unknown) => {
    return new ModioClient(config).getGameTagGroups(requireString(rawGameId, "Game ID"));
  });

  ipcMain.handle("subscriptions:details", async (_event, rawGameId: unknown) => {
    requireSignedIn();
    const gameId = requireString(rawGameId, "Game ID");
    if (!subscriptions.some((mod) => mod.gameId === gameId)) {
      throw new Error("The selected game has no subscribed mods to inspect.");
    }
    return new ModioClient(config).getSubscribedModDetails(gameId, subscriptions);
  });

  ipcMain.handle("subscriptions:unsubscribe", async (_event, input: { gameId: string; modId: string }) => {
    requireSignedIn();
    const gameId = requireString(input?.gameId, "Game ID");
    const modId = requireString(input?.modId, "Mod ID");
    if (!subscriptions.some((mod) => mod.gameId === gameId && mod.modId === modId)) {
      throw new Error("That mod is not in your subscriptions.");
    }
    await new ModioClient(config).unsubscribe(gameId, modId);
    subscriptions = await new ModioClient(config).getSubscriptions();
    await hydrateGameArtwork();
    return getPublicState(`Unsubscribed from ${modId}.`);
  });

  ipcMain.handle("catalog:subscribe", async (_event, input: { gameId: string; modId: string }) => {
    requireSignedIn();
    await new ModioClient(config).subscribe(
      requireString(input?.gameId, "Game ID"),
      requireString(input?.modId, "Mod ID"),
    );
    subscriptions = await new ModioClient(config).getSubscriptions();
    await hydrateGameArtwork();
  });

  ipcMain.handle("games:save-settings", async (_event, input: GameSettingsInput) => {
    applyGameSettings(input);
    await saveConfig(config);
    return getPublicState("Game settings saved.");
  });

  ipcMain.handle("games:choose-folder", async (_event, rawGameId: unknown) => {
    const gameId = requireString(rawGameId, "Game ID");
    const game = getPublicState().games.find((item) => item.id === gameId);
    if (!game) throw new Error("The selected game is no longer in the library.");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: `Choose a mod folder for ${game.name}`,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    applyGameSettings({ gameId, targetPath: result.filePaths[0] });
    await saveConfig(config);
    return getPublicState("Install folder saved.");
  });

  ipcMain.handle("sync:games", async (_event, rawGameIds: unknown) => {
    requireSignedIn();
    if (!Array.isArray(rawGameIds) || rawGameIds.some((id) => typeof id !== "string")) {
      throw new Error("Choose one or more games to sync.");
    }
    if (syncRunning) throw new Error("A sync operation is already running.");
    const gameIds = new Set(rawGameIds as string[]);
    if (gameIds.size === 0) throw new Error("Choose at least one game to sync.");
    const missingPath = [...gameIds].filter((id) => !config.games[id]?.targetPath);
    if (missingPath.length) {
      const names = getPublicState().games.filter((game) => missingPath.includes(game.id)).map((game) => game.name);
      throw new Error(`Choose an install folder for: ${names.join(", ")}`);
    }

    syncRunning = true;
    try {
      const selected = subscriptions.filter((mod) => gameIds.has(mod.gameId));
      await syncMods(selected, config, (message) => mainWindow?.webContents.send("sync:progress", message));
    } finally {
      syncRunning = false;
    }
  });

  ipcMain.on("window:action", (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (action === "minimize") window.minimize();
    else if (action === "toggle-maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    } else if (action === "close") window.close();
  });
}

function getPublicState(message = startupMessage): PublicAppState {
  const grouped = new Map<string, SubscribedMod[]>();
  for (const mod of subscriptions) {
    const list = grouped.get(mod.gameId) || [];
    list.push(mod);
    grouped.set(mod.gameId, list);
  }

  const ids = new Set([...grouped.keys(), ...Object.keys(config.games)]);
  const games: SubscribedGame[] = [...ids].map((id) => {
    const mods = grouped.get(id) || [];
    const mapping = config.games[id] || defaultMapping(mods[0]?.gameName || `Game ${id}`);
    return {
      id,
      name: mods[0]?.gameName || mapping.gameName,
      modCount: mods.length,
      logoUrl: mapping.logoUrl || null,
      targetPath: mapping.targetPath,
      targetPlatform: mapping.targetPlatform,
      extractArchives: mapping.extractArchives,
      selected: mapping.selected ?? true,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    apiKeyConfigured: Boolean(config.apiKey),
    userId: config.userId,
    signedIn: Boolean(config.accessToken),
    games,
    subscriptions,
    configPath: getConfigPath(),
    message,
  };
}

async function hydrateGameArtwork(): Promise<void> {
  const api = new ModioClient(config);
  const artworkFailures: string[] = [];
  for (const gameId of new Set(subscriptions.map((mod) => mod.gameId))) {
    const gameName = subscriptions.find((mod) => mod.gameId === gameId)?.gameName || `Game ${gameId}`;
    const mapping = config.games[gameId] || defaultMapping(gameName);
    mapping.gameName = gameName;
    if (!mapping.logoUrl) {
      try {
        mapping.logoUrl = (await api.getGame(gameId)).logoUrl || undefined;
      } catch (error) {
        mapping.logoUrl = undefined;
        artworkFailures.push(`${gameName}: ${getErrorMessage(error)}`);
      }
    }
    config.games[gameId] = mapping;
  }
  await saveConfig(config);
  if (artworkFailures.length) {
    startupMessage = `Some game artwork could not be loaded: ${artworkFailures.join("; ")}`;
  }
}

function applyGameSettings(input: GameSettingsInput): void {
  const gameId = requireString(input?.gameId, "Game ID");
  const current = config.games[gameId] || defaultMapping(
    subscriptions.find((mod) => mod.gameId === gameId)?.gameName || `Game ${gameId}`,
  );
  const next: GameMapping = { ...current };
  if (input.targetPath !== undefined) next.targetPath = requireString(input.targetPath, "Install folder");
  if (input.targetPlatform !== undefined) {
    if (input.targetPlatform !== "windows" && input.targetPlatform !== "android") {
      throw new Error("Choose Windows or Android as the mod platform.");
    }
    next.targetPlatform = input.targetPlatform as Platform;
  }
  if (input.extractArchives !== undefined) next.extractArchives = Boolean(input.extractArchives);
  if (input.selected !== undefined) next.selected = Boolean(input.selected);
  config.games[gameId] = next;
}

function defaultMapping(gameName: string): GameMapping & { logoUrl?: string; selected?: boolean } {
  return { gameName, targetPath: "", targetPlatform: "windows", extractArchives: true, selected: true };
}

function requireSignedIn(): void {
  if (!config.accessToken) throw new Error("Sign in to your mod.io account first.");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || (!value.trim() && label !== "Search query")) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}

function clampLimit(value: unknown): number {
  return Math.min(Math.max(requireInteger(value, "Page size"), 1), 100);
}

function requireModSortField(value: unknown): ModSortField {
  if (value === "popular" || value === "rating" || value === "downloads" || value === "subscribers") {
    return value;
  }
  throw new Error("Choose a supported mod sort field.");
}

function requireSortDirection(value: unknown): SortDirection {
  if (value === "asc" || value === "desc") return value;
  throw new Error("Choose ascending or descending sort order.");
}

function requireTagFilters(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2
    || value.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100)) {
    throw new Error("Choose valid mod tags.");
  }
  return value.map((tag: string) => tag.trim());
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void app.whenReady().then(async () => {
  try {
    const loaded = await loadConfig();
    config = loaded.config;
    startupMessage = loaded.migrationMessage;
  } catch (error) {
    startupMessage = getErrorMessage(error);
  }
  registerHandlers();
  createWindow();
  setupAutoUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
