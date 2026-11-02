export type Platform = "windows" | "android";

export interface GameMapping {
  gameName: string;
  targetPath: string;
  extractArchives: boolean;
  targetPlatform: Platform;
  logoUrl?: string;
  selected?: boolean;
}

export interface AppConfig {
  apiKey: string;
  userId: string;
  accessToken: string;
  games: Record<string, GameMapping>;
}

export interface PublicAppState {
  apiKeyConfigured: boolean;
  userId: string;
  signedIn: boolean;
  games: SubscribedGame[];
  subscriptions: SubscribedMod[];
  configPath: string;
  message?: string;
}

export interface SubscribedGame {
  id: string;
  name: string;
  modCount: number;
  logoUrl: string | null;
  targetPath: string;
  targetPlatform: Platform;
  extractArchives: boolean;
  selected: boolean;
}

export interface SubscribedMod {
  gameId: string;
  gameName: string;
  modId: string;
  modName: string;
}

export interface SubscribedModDetails {
  modId: string;
  modName: string;
  logoUrl: string | null;
  platforms: Platform[];
}

export interface CatalogGame {
  id: string;
  name: string;
  summary: string;
  logoUrl: string | null;
  modCount: number;
}

export interface CatalogMod {
  id: string;
  gameId: string;
  name: string;
  summary: string;
  logoUrl: string | null;
  downloads: number;
  subscribers: number;
  isSubscribed: boolean;
}

export interface GameSettingsInput {
  gameId: string;
  targetPath?: string;
  targetPlatform?: Platform;
  extractArchives?: boolean;
  selected?: boolean;
}

export interface AppUpdateState {
  status: "idle" | "checking" | "not-available" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  releaseNotes?: string;
  percent?: number;
  message?: string;
}

export interface ModioDesktopApi {
  getInitialState(): Promise<PublicAppState>;
  requestLoginCode(input: { apiKey: string; userId: string; email: string }): Promise<void>;
  verifyLoginCode(code: string): Promise<PublicAppState>;
  refreshSubscriptions(): Promise<PublicAppState>;
  logout(): Promise<PublicAppState>;
  browseGames(input: { query: string; offset: number; limit: number }): Promise<CatalogGame[]>;
  browseMods(input: { gameId: string; query: string; offset: number; limit: number }): Promise<CatalogMod[]>;
  getSubscribedModDetails(gameId: string): Promise<SubscribedModDetails[]>;
  unsubscribeFromMod(input: { gameId: string; modId: string }): Promise<PublicAppState>;
  subscribeToMod(input: { gameId: string; modId: string }): Promise<void>;
  saveGameSettings(input: GameSettingsInput): Promise<PublicAppState>;
  chooseGameFolder(gameId: string): Promise<PublicAppState | null>;
  syncGames(gameIds: string[]): Promise<void>;
  getUpdateState(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<void>;
  installUpdate(): void;
  onUpdateState(callback: (state: AppUpdateState) => void): () => void;
  onSyncProgress(callback: (message: string) => void): () => void;
  windowAction(action: "minimize" | "toggle-maximize" | "close"): void;
}
