import { contextBridge, ipcRenderer } from "electron";
import type { AppUpdateState, GameSettingsInput, ModioDesktopApi } from "./types";

const api: ModioDesktopApi = {
  getInitialState: () => ipcRenderer.invoke("app:initial-state"),
  requestLoginCode: (input) => ipcRenderer.invoke("auth:request-code", input),
  verifyLoginCode: (code) => ipcRenderer.invoke("auth:verify-code", code),
  refreshSubscriptions: () => ipcRenderer.invoke("subscriptions:refresh"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  browseGames: (input) => ipcRenderer.invoke("catalog:games", input),
  browseMods: (input) => ipcRenderer.invoke("catalog:mods", input),
  getGameTagGroups: (gameId) => ipcRenderer.invoke("catalog:tag-groups", gameId),
  getSubscribedModDetails: (gameId) => ipcRenderer.invoke("subscriptions:details", gameId),
  unsubscribeFromMod: (input) => ipcRenderer.invoke("subscriptions:unsubscribe", input),
  subscribeToMod: (input) => ipcRenderer.invoke("catalog:subscribe", input),
  saveGameSettings: (input: GameSettingsInput) => ipcRenderer.invoke("games:save-settings", input),
  chooseGameFolder: (gameId) => ipcRenderer.invoke("games:choose-folder", gameId),
  syncGames: (gameIds) => ipcRenderer.invoke("sync:games", gameIds),
  getUpdateState: () => ipcRenderer.invoke("updates:get-state"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.send("updates:install"),
  onUpdateState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => callback(state);
    ipcRenderer.on("updates:state", listener);
    return () => ipcRenderer.removeListener("updates:state", listener);
  },
  windowAction: (action) => ipcRenderer.send("window:action", action),
  onSyncProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("sync:progress", listener);
    return () => ipcRenderer.removeListener("sync:progress", listener);
  },
};

contextBridge.exposeInMainWorld("modio", api);
