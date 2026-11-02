import type {
  AppConfig,
  CatalogGame,
  CatalogMod,
  CatalogTagGroup,
  ModSortField,
  Platform,
  SortDirection,
  SubscribedMod,
  SubscribedModDetails,
} from "./types";

const pageSize = 100;
const minimumRequestIntervalMs = 250;
const maxRateLimitRetries = 4;

let requestQueue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;
let rateLimitUntil = 0;

function enqueueModioRequest(request: () => Promise<Response>): Promise<Response> {
  const result = requestQueue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const waitUntil = Math.max(nextRequestAt, rateLimitUntil);
      const waitMs = waitUntil - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      const response = await request();
      nextRequestAt = Date.now() + minimumRequestIntervalMs;
      if (response.status !== 429 || attempt >= maxRateLimitRetries) return response;

      const retryDelay = getRateLimitRetryDelay(response, attempt);
      rateLimitUntil = Math.max(rateLimitUntil, Date.now() + retryDelay);
    }
  });
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

function getRateLimitRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }

  const reset = Number(response.headers.get("X-RateLimit-Reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now());
  }

  return Math.min(1000 * 2 ** attempt, 30_000);
}

export class ModioClient {
  private readonly root: string;

  constructor(private readonly config: AppConfig) {
    if (!/^\d+$/.test(config.userId)) {
      throw new Error("Enter the numeric mod.io User ID from your profile.");
    }
    if (!config.apiKey) throw new Error("Enter your mod.io API key first.");
    this.root = `https://u-${config.userId}.modapi.io/v1/`;
  }

  async requestLoginCode(email: string): Promise<void> {
    await this.request("oauth/emailrequest", {
      method: "POST",
      body: new URLSearchParams({ email }),
      authenticated: false,
    });
  }

  async exchangeLoginCode(code: string): Promise<string> {
    const response = await this.request("oauth/emailexchange", {
      method: "POST",
      body: new URLSearchParams({ security_code: code }),
      authenticated: false,
    });
    const result = await response.json() as { access_token?: string };
    if (!result.access_token) throw new Error("mod.io did not return an access token.");
    return result.access_token;
  }

  async getSubscriptions(): Promise<SubscribedMod[]> {
    const result: SubscribedMod[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.getData("me/subscribed", { _limit: pageSize, _offset: offset });
      result.push(...page.map(parseSubscription).filter((mod): mod is SubscribedMod => mod !== null));
      if (page.length < pageSize) break;
    }

    const missingNames = [...new Set(result.filter((mod) => mod.gameName === mod.gameId).map((mod) => mod.gameId))];
    for (const id of missingNames) {
      const game = await this.getGame(id);
      for (const mod of result.filter((item) => item.gameId === id)) mod.gameName = game.name;
    }
    return result.sort((a, b) => a.gameName.localeCompare(b.gameName) || a.modName.localeCompare(b.modName));
  }

  async getSubscribedModDetails(gameId: string, mods: SubscribedMod[]): Promise<SubscribedModDetails[]> {
    const gameMods = mods.filter((mod) => mod.gameId === gameId);
    const result: SubscribedModDetails[] = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < gameMods.length) {
        const mod = gameMods[nextIndex++];
        const [details, platforms] = await Promise.all([
          this.getModDetails(mod),
          this.getAvailablePlatforms(mod),
        ]);
        result.push({ modId: mod.modId, modName: details.name, logoUrl: details.logoUrl, platforms });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, gameMods.length) }, worker));
    return result;
  }

  private async getModDetails(mod: SubscribedMod): Promise<CatalogMod> {
    const response = await this.request(
      `games/${encodeURIComponent(mod.gameId)}/mods/${encodeURIComponent(mod.modId)}`,
    );
    const parsed = parseMod(await response.json() as Record<string, unknown>);
    if (!parsed) throw new Error(`mod.io returned invalid details for mod ${mod.modId}.`);
    return parsed;
  }

  private async getAvailablePlatforms(mod: SubscribedMod): Promise<Platform[]> {
    const platforms = new Set<Platform>();
    for (let offset = 0; ; offset += pageSize) {
      const files = await this.getData(
        `games/${encodeURIComponent(mod.gameId)}/mods/${encodeURIComponent(mod.modId)}/files`,
        { _limit: pageSize, _offset: offset },
      );
      for (const file of files) {
        if (!Array.isArray(file.platforms)) continue;
        for (const entry of file.platforms) {
          const platform = objectValue(entry)?.platform;
          if (platform === "windows" || platform === "android") platforms.add(platform);
        }
      }
      if (files.length < pageSize) break;
    }
    return [...platforms];
  }

  async getGame(id: string): Promise<CatalogGame> {
    const response = await this.request(`games/${encodeURIComponent(id)}`);
    const value = await response.json() as Record<string, unknown>;
    const game = parseGame(value);
    if (!game) throw new Error(`mod.io returned invalid details for game ${id}.`);
    return game;
  }

  async getGames(query: string, offset: number, limit: number): Promise<CatalogGame[]> {
    const data = await this.getData("games", {
      _limit: limit,
      _offset: offset,
      _sort: "-popular",
      ...(query.trim() ? { _q: query.trim() } : {}),
    });
    return data.map(parseGame).filter((game): game is CatalogGame => game !== null);
  }

  async getMods(
    gameId: string,
    query: string,
    offset: number,
    limit: number,
    sortField: ModSortField,
    sortDirection: SortDirection,
    tagFilters: string[],
  ): Promise<CatalogMod[]> {
    const data = await this.getData(`games/${encodeURIComponent(gameId)}/mods`, {
      _limit: limit,
      _offset: offset,
      _sort: `${sortDirection === "desc" ? "-" : ""}${sortField}`,
      ...(query.trim() ? { _q: query.trim() } : {}),
      ...(tagFilters.length ? { tags: tagFilters.join(",") } : {}),
    });
    return data.map(parseMod).filter((mod): mod is CatalogMod => mod !== null);
  }

  async getGameTagGroups(gameId: string): Promise<CatalogTagGroup[]> {
    const data = await this.getData(`games/${encodeURIComponent(gameId)}/tags`, { _limit: pageSize });
    return data.flatMap((entry) => {
      const name = stringValue(entry.name);
      if (!name || !Array.isArray(entry.tags)) return [];
      const tags = entry.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
      return tags.length ? [{ name, tags }] : [];
    });
  }

  async subscribe(gameId: string, modId: string): Promise<void> {
    await this.request(
      `games/${encodeURIComponent(gameId)}/mods/${encodeURIComponent(modId)}/subscribe`,
      { method: "POST", body: new URLSearchParams() },
    );
  }

  async unsubscribe(gameId: string, modId: string): Promise<void> {
    await this.request(
      `games/${encodeURIComponent(gameId)}/mods/${encodeURIComponent(modId)}/subscribe`,
      { method: "DELETE", body: new URLSearchParams() },
    );
  }

  async getDownloadUrl(mod: SubscribedMod, platform: Platform): Promise<string> {
    let selectedUrl = "";
    let selectedDate = -1;
    for (let offset = 0; ; offset += pageSize) {
      const files = await this.getData(
        `games/${encodeURIComponent(mod.gameId)}/mods/${encodeURIComponent(mod.modId)}/files`,
        { _limit: pageSize, _offset: offset },
        platform,
      );
      for (const file of files) {
        const platforms = Array.isArray(file.platforms) ? file.platforms as { platform?: string }[] : [];
        if (!platforms.some((item) => item.platform?.toLowerCase() === platform)) continue;
        const download = file.download as { binary_url?: string } | undefined;
        const date = Number(file.date_added || 0);
        if (download?.binary_url && date > selectedDate) {
          selectedDate = date;
          selectedUrl = download.binary_url;
        }
      }
      if (files.length < pageSize) break;
    }
    if (!selectedUrl) throw new Error(`No ${platform} file is available.`);
    return selectedUrl;
  }

  private async getData(
    endpoint: string,
    params: Record<string, string | number>,
    platform?: Platform,
  ): Promise<Record<string, unknown>[]> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const response = await this.request(`${endpoint}?${query.toString()}`, { platform });
    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload.data)) throw new Error("mod.io returned an invalid list response.");
    return payload.data.filter((value): value is Record<string, unknown> => !!value && typeof value === "object");
  }

  private async request(
    endpoint: string,
    options: { method?: string; body?: URLSearchParams; authenticated?: boolean; platform?: Platform } = {},
  ): Promise<Response> {
    const url = new URL(endpoint, this.root);
    url.searchParams.set("api_key", this.config.apiKey);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "ModioManager/2.0" };
    if (options.authenticated !== false && this.config.accessToken) {
      headers.Authorization = `Bearer ${this.config.accessToken}`;
    }
    if (options.platform) headers["X-Modio-Platform"] = options.platform;
    if (options.body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const response = await enqueueModioRequest(() => fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body?.toString(),
      signal: AbortSignal.timeout(600_000),
    }));
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`mod.io API ${response.status} ${response.statusText}: ${details}`);
    }
    return response;
  }
}

function parseGame(value: Record<string, unknown>): CatalogGame | null {
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  if (!id || !name) return null;
  const logo = objectValue(value.logo);
  const stats = objectValue(value.stats);
  return {
    id,
    name,
    summary: stringValue(value.summary) || "",
    logoUrl: stringValue(logo?.thumb_320x180) || stringValue(logo?.original) || null,
    modCount: numberValue(value.mods_count ?? stats?.mods_count),
  };
}

function parseMod(value: Record<string, unknown>): CatalogMod | null {
  const id = stringValue(value.id);
  const gameId = stringValue(value.game_id);
  const name = stringValue(value.name);
  if (!id || !gameId || !name) return null;
  const logo = objectValue(value.logo);
  const stats = objectValue(value.stats);
  return {
    id,
    gameId,
    name,
    summary: stringValue(value.summary) || "",
    logoUrl: stringValue(logo?.thumb_320x180) || stringValue(logo?.original) || null,
    downloads: numberValue(stats?.downloads_total),
    subscribers: numberValue(stats?.subscribers_total),
    isSubscribed: false,
  };
}

function parseSubscription(value: Record<string, unknown>): SubscribedMod | null {
  const nested = objectValue(value.mod);
  const game = objectValue(value.game) || objectValue(nested?.game);
  const gameId = stringValue(value.game_id) || stringValue(game?.id) || stringValue(nested?.game_id);
  const gameName = stringValue(value.game_name) || stringValue(game?.name) || gameId;
  const modId = stringValue(value.mod_id) || stringValue(nested?.id) || stringValue(value.id);
  const modName = stringValue(value.mod_name) || stringValue(nested?.name) || modId;
  if (!gameId || !modId) return null;
  return { gameId, gameName: gameName || gameId, modId, modName: modName || `Mod ${modId}` };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function numberValue(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
