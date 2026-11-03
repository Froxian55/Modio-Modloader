import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  CatalogGame,
  CatalogMod,
  CatalogTagGroup,
  GameSettingsInput,
  AppUpdateState,
  ModSortField,
  Platform,
  PublicAppState,
  SortDirection,
  SubscribedGame,
  SubscribedModDetails,
} from "../electron/types";

type Section = "library" | "discover";

const pageSize = 40;
const emptyState: PublicAppState = {
  apiKeyConfigured: false,
  userId: "",
  signedIn: false,
  games: [],
  subscriptions: [],
  configPath: "",
};

export default function App() {
  const [section, setSection] = useState<Section>("library");
  const [state, setState] = useState<PublicAppState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [gameFilter, setGameFilter] = useState("");
  const [selectedGameId, setSelectedGameId] = useState("");
  const [modDetailsByGame, setModDetailsByGame] = useState<Record<string, Record<string, SubscribedModDetails>>>({});
  const [modDetailsErrors, setModDetailsErrors] = useState<Record<string, string>>({});
  const [modDetailsLoadingGameId, setModDetailsLoadingGameId] = useState("");
  const [modDetailsRetry, setModDetailsRetry] = useState(0);
  const [catalogGames, setCatalogGames] = useState<CatalogGame[]>([]);
  const [hasMoreCatalogGames, setHasMoreCatalogGames] = useState(false);
  const [gameQuery, setGameQuery] = useState("");
  const [gameOffset, setGameOffset] = useState(0);
  const [selectedCatalogGame, setSelectedCatalogGame] = useState<CatalogGame | null>(null);
  const [catalogMods, setCatalogMods] = useState<CatalogMod[]>([]);
  const [catalogTagGroups, setCatalogTagGroups] = useState<CatalogTagGroup[]>([]);
  const [selectedGameVersion, setSelectedGameVersion] = useState("");
  const [selectedModTagGroup, setSelectedModTagGroup] = useState("");
  const [selectedModTag, setSelectedModTag] = useState("");
  const [selectedPlatformFilter, setSelectedPlatformFilter] = useState<Platform | "">("");
  const [hasMoreCatalogMods, setHasMoreCatalogMods] = useState(false);
  const [modQuery, setModQuery] = useState("");
  const [modOffset, setModOffset] = useState(0);
  const [modSortField, setModSortField] = useState<ModSortField>("popular");
  const [modSortDirection, setModSortDirection] = useState<SortDirection>("desc");
  const [selectedMod, setSelectedMod] = useState<CatalogMod | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [toast, setToast] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ status: "idle" });
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const announce = useCallback((message: string) => {
    setToast(message);
    setActivity((items) => [`${new Date().toLocaleTimeString()}  ${message}`, ...items].slice(0, 60));
    window.setTimeout(() => setToast(""), 4200);
  }, []);

  const applyState = useCallback((next: PublicAppState) => {
    setState(next);
    if (next.message) announce(next.message);
    setLoaded(true);
  }, [announce]);

  useEffect(() => {
    let active = true;
    void window.modio.getInitialState()
      .then((next) => {
        if (active) applyState(next);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoaded(true);
          announce(errorMessage(error));
        }
      });
    const unsubscribe = window.modio.onSyncProgress((message) => {
      setActivity((items) => [`${new Date().toLocaleTimeString()}  ${message}`, ...items].slice(0, 60));
      setToast(message);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [announce, applyState]);

  useEffect(() => {
    let receivedEvent = false;
    const unsubscribe = window.modio.onUpdateState((next) => {
      receivedEvent = true;
      if (next.status === "available" || next.status === "downloaded") setUpdateDismissed(false);
      setAppUpdate(next);
    });
    void window.modio.getUpdateState()
      .then((next) => {
        if (!receivedEvent) setAppUpdate(next);
      })
      .catch((error: unknown) => announce(`Could not check for app updates: ${errorMessage(error)}`));
    return unsubscribe;
  }, [announce]);

  useEffect(() => {
    if (appUpdate.status === "error" && appUpdate.message) {
      announce(`App update error: ${appUpdate.message}`);
    } else if (appUpdate.status === "not-available") {
      announce("The app is up to date.");
    }
  }, [announce, appUpdate.message, appUpdate.status]);

  useEffect(() => {
    if (!userId && state.userId) setUserId(state.userId);
  }, [state.userId, userId]);

  const visibleGames = useMemo(() => state.games.filter((game) =>
    game.name.toLocaleLowerCase().includes(gameFilter.trim().toLocaleLowerCase())), [state.games, gameFilter]);
  const selectedGame = state.games.find((game) => game.id === selectedGameId) || null;
  const selectedModsCount = state.subscriptions.filter((mod) =>
    state.games.some((game) => game.id === mod.gameId && game.selected)).length;

  useEffect(() => {
    if (!selectedGame || !state.signedIn || modDetailsByGame[selectedGame.id]) return;
    let active = true;
    setModDetailsLoadingGameId(selectedGame.id);
    setModDetailsErrors((current) => {
      const next = { ...current };
      delete next[selectedGame.id];
      return next;
    });
    void window.modio.getSubscribedModDetails(selectedGame.id)
      .then((details) => {
        if (active) {
          setModDetailsByGame((current) => ({
            ...current,
            [selectedGame.id]: Object.fromEntries(details.map((item) => [item.modId, item])),
          }));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setModDetailsErrors((current) => ({ ...current, [selectedGame.id]: errorMessage(error) }));
        }
      })
      .finally(() => {
        if (active) setModDetailsLoadingGameId((current) => current === selectedGame.id ? "" : current);
      });
    return () => {
      active = false;
    };
  }, [modDetailsByGame, modDetailsRetry, selectedGame, state.signedIn]);

  async function runAction<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(true);
    setBusyLabel(label);
    try {
      return await action();
    } catch (error) {
      announce(errorMessage(error));
      return undefined;
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    const result = await runAction("Sending sign-in code…", async () => {
      await window.modio.requestLoginCode({ apiKey, userId, email });
      return true;
    });
    if (result) {
      setCodeSent(true);
      setState((current) => ({ ...current, apiKeyConfigured: true, userId }));
      announce("Security code sent. Check your email.");
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    const next = await runAction("Signing in…", () => window.modio.verifyLoginCode(code));
    if (next) {
      setCode("");
      setCodeSent(false);
      setModDetailsByGame({});
      applyState(next);
    }
  }

  async function refreshSubscriptions() {
    const next = await runAction("Refreshing your library…", () => window.modio.refreshSubscriptions());
    if (next) {
      setModDetailsByGame({});
      applyState(next);
    }
  }

  async function logout() {
    const next = await runAction("Signing out…", () => window.modio.logout());
    if (next) {
      setModDetailsByGame({});
      applyState(next);
    }
  }

  async function openDiscover() {
    setSection("discover");
    if (catalogGames.length === 0) await searchGames("", false);
  }

  async function searchGames(query = gameQuery, append = false) {
    const actualQuery = query.trim();
    const offset = append ? gameOffset : 0;
    const results = await runAction("Finding games…", () =>
      window.modio.browseGames({ query: actualQuery, offset, limit: pageSize }));
    if (!results) return;
    setGameQuery(actualQuery);
    setCatalogGames((current) => append ? [...current, ...results] : results);
    setGameOffset(offset + results.length);
    setHasMoreCatalogGames(results.length === pageSize);
  }

  async function openCatalogGame(game: CatalogGame) {
    setSelectedCatalogGame(game);
    setModQuery("");
    setModOffset(0);
    setSelectedGameVersion("");
    setSelectedModTagGroup("");
    setSelectedModTag("");
    setSelectedPlatformFilter("");
    const results = await runAction(`Loading ${game.name} mods…`, async () => {
      const mods = await window.modio.browseMods({
        gameId: game.id,
        query: "",
        offset: 0,
        limit: pageSize,
        sortField: modSortField,
        sortDirection: modSortDirection,
        tagFilters: [],
        platformFilter: "",
      });
      let tagGroups: CatalogTagGroup[] = [];
      try {
        tagGroups = await window.modio.getGameTagGroups(game.id);
      } catch (error) {
        announce(`Could not load mod filters: ${errorMessage(error)}`);
      }
      return { mods, tagGroups };
    });
    if (results) {
      setCatalogTagGroups(results.tagGroups);
      setCatalogMods(results.mods);
      setModOffset(results.mods.length);
      setHasMoreCatalogMods(results.mods.length === pageSize);
    }
  }

  async function searchMods(
    query = modQuery,
    append = false,
    sortField = modSortField,
    sortDirection = modSortDirection,
    gameVersion = selectedGameVersion,
    tagGroup = selectedModTagGroup,
    modTag = selectedModTag,
    platformFilter = selectedPlatformFilter,
  ) {
    if (!selectedCatalogGame) return;
    const actualQuery = query.trim();
    const offset = append ? modOffset : 0;
    const tagFilters = [gameVersion, tagGroup && modTag ? modTag : ""].filter(Boolean);
    const results = await runAction("Searching mods…", () =>
      window.modio.browseMods({
        gameId: selectedCatalogGame.id,
        query: actualQuery,
        offset,
        limit: pageSize,
        sortField,
        sortDirection,
        tagFilters,
        platformFilter,
      }));
    if (results) {
      setModQuery(actualQuery);
      setModSortField(sortField);
      setModSortDirection(sortDirection);
      setSelectedGameVersion(gameVersion);
      setSelectedModTagGroup(tagGroup);
      setSelectedModTag(modTag);
      setSelectedPlatformFilter(platformFilter);
      setCatalogMods((current) => append ? [...current, ...results] : results);
      setModOffset(offset + results.length);
      setHasMoreCatalogMods(results.length === pageSize);
    }
  }

  async function subscribe(mod: CatalogMod) {
    await runAction(`Subscribing to ${mod.name}…`, async () => {
      await window.modio.subscribeToMod({ gameId: mod.gameId, modId: mod.id });
      setCatalogMods((mods) => mods.map((item) =>
        item.id === mod.id ? { ...item, isSubscribed: true } : item));
      const next = await window.modio.refreshSubscriptions();
      setModDetailsByGame({});
      setState(next);
      announce(`Subscribed to ${mod.name}.`);
    });
  }

  async function unsubscribe(modId: string) {
    const mod = state.subscriptions.find((item) => item.gameId === selectedGameId && item.modId === modId);
    if (!mod) return;
    const next = await runAction(`Unsubscribing from ${mod.modName}…`, () =>
      window.modio.unsubscribeFromMod({ gameId: selectedGameId, modId }));
    if (next) {
      setModDetailsByGame((current) => {
        const updated = { ...current };
        delete updated[selectedGameId];
        return updated;
      });
      applyState({ ...next, message: `Unsubscribed from ${mod.modName}.` });
    }
  }

  async function updateGame(input: GameSettingsInput) {
    const next = await runAction("Saving game settings…", () => window.modio.saveGameSettings(input));
    if (next) setState(next);
  }

  async function chooseFolder(game: SubscribedGame) {
    const next = await runAction("Choose an install folder…", () => window.modio.chooseGameFolder(game.id));
    if (next) setState(next);
  }

  async function syncSelected() {
    const ids = state.games.filter((game) => game.selected).map((game) => game.id);
    const result = await runAction("Syncing selected games…", async () => {
      setSyncing(true);
      try {
        await window.modio.syncGames(ids);
        announce("Sync finished.");
      } finally {
        setSyncing(false);
      }
    });
    if (result !== undefined) setSyncing(false);
  }

  async function downloadAppUpdate() {
    try {
      await window.modio.downloadUpdate();
    } catch (error) {
      announce(`Could not download the update: ${errorMessage(error)}`);
    }
  }

  if (!loaded) {
    return <div className="boot-screen"><img className="brand-icon" src="./app-icon.ico" alt=""/><span>Starting Modio Manager</span></div>;
  }

  if (!state.signedIn) {
    return (
      <div className="app-shell auth-shell">
        <header className="titlebar">
          <div className="brand-lockup">
            <img className="brand-icon" src="./app-icon.ico" alt=""/>
            <div><strong>MODIO</strong><span>MOD MANAGER</span></div>
          </div>
          <div className="window-caption">Your mods, organized.</div>
          <div className="window-controls">
            <button aria-label="Minimize" onClick={() => window.modio.windowAction("minimize")}>−</button>
            <button aria-label="Maximize" onClick={() => window.modio.windowAction("toggle-maximize")}>□</button>
            <button className="close-control" aria-label="Close" onClick={() => window.modio.windowAction("close")}>×</button>
          </div>
        </header>
        <main className="auth-page">
          <section className="auth-card">
            <img className="auth-logo" src="./app-icon.ico" alt="Modio Manager"/>
            <span className="eyebrow accent">WELCOME BACK</span>
            <h1>Sign in to mod.io</h1>
            <p className="auth-intro">Connect your account to browse and manage your subscribed mods.</p>
            <form className="sign-in-form auth-sign-in-form" onSubmit={(event) => void (codeSent ? verifyCode(event) : requestCode(event))}>
              {!state.apiKeyConfigured && (
                <>
                  <label>API key</label>
                  <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" required/>
                  <label>Numeric user ID</label>
                  <input value={userId} onChange={(event) => setUserId(event.target.value)} inputMode="numeric"
                         pattern="[0-9]+" autoComplete="off" required/>
                </>
              )}
              <label>Account email</label>
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required/>
              {codeSent && (
                <>
                  <label>Security code</label>
                  <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required/>
                </>
              )}
              <button className="primary-button full-width" type="submit" disabled={busy}>
                {codeSent ? "Verify and sign in" : "Send sign-in code"}
              </button>
              {codeSent && <button className="text-button auth-change-email" type="button" onClick={() => setCodeSent(false)}>Use a different email</button>}
              <small>Credentials are encrypted locally with Windows secure storage.</small>
            </form>
          </section>
        </main>
        {busy && <div className="busy-indicator"><span className="spinner"/>{busyLabel || "Working…"}</div>}
        {toast && !busy && <div className="toast"><span className="toast-dot"/> {toast}</div>}
        {(appUpdate.status === "available" || appUpdate.status === "downloading" || appUpdate.status === "downloaded"
          || (appUpdate.status === "error" && Boolean(appUpdate.version))) && !updateDismissed && (
          <UpdateDialog
            update={appUpdate}
            onLater={() => setUpdateDismissed(true)}
            onDownload={() => void downloadAppUpdate()}
            onInstall={() => window.modio.installUpdate()}
          />
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-lockup">
          <img className="brand-icon" src="./app-icon.ico" alt=""/>
          <div><strong>MODIO</strong><span>MOD MANAGER</span></div>
        </div>
        <div className="window-caption">Your mods, organized.</div>
        <div className="window-controls">
          <button aria-label="Minimize" onClick={() => window.modio.windowAction("minimize")}>−</button>
          <button aria-label="Maximize" onClick={() => window.modio.windowAction("toggle-maximize")}>□</button>
          <button className="close-control" aria-label="Close" onClick={() => window.modio.windowAction("close")}>×</button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-group">
            <span className="eyebrow">WORKSPACE</span>
            <button className={`nav-item ${section === "library" ? "active" : ""}`} onClick={() => setSection("library")}>
              <span className="nav-icon">▦</span><span>My library</span><span className="nav-count">{state.games.length}</span>
            </button>
            <button className={`nav-item ${section === "discover" ? "active" : ""}`} onClick={() => void openDiscover()}>
              <span className="nav-icon">⌕</span><span>Discover mods</span>
            </button>
          </div>

          <div className="sidebar-divider"/>
          <div className="account-card">
            <div className="account-heading">
              <span className={`status-dot ${state.signedIn ? "online" : ""}`}/>
              <span>{state.signedIn ? "CONNECTED" : "ACCOUNT"}</span>
            </div>
            {state.signedIn ? (
              <>
                <strong>mod.io account</strong>
                <span className="account-copy">{state.subscriptions.length.toLocaleString()} followed mods ready to sync</span>
                <button className="quiet-button" onClick={() => void logout()} disabled={busy}>Sign out</button>
              </>
            ) : (
              <form className="sign-in-form" onSubmit={(event) => void (codeSent ? verifyCode(event) : requestCode(event))}>
                {!state.apiKeyConfigured && (
                  <>
                    <label>API key</label>
                    <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" required/>
                    <label>Numeric user ID</label>
                    <input value={userId} onChange={(event) => setUserId(event.target.value)} inputMode="numeric"
                           pattern="[0-9]+" autoComplete="off" required/>
                  </>
                )}
                <label>Account email</label>
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required/>
                {codeSent && (
                  <>
                    <label>Security code</label>
                    <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required/>
                  </>
                )}
                <button className="primary-button full-width" type="submit" disabled={busy}>
                  {codeSent ? "Verify and sign in" : "Send sign-in code"}
                </button>
                {codeSent && <button className="text-button" type="button" onClick={() => setCodeSent(false)}>Use a different email</button>}
                <small>Credentials are encrypted locally with Windows secure storage.</small>
              </form>
            )}
          </div>

          <div className="sidebar-spacer"/>
          <div className="storage-note">
            <span className="storage-icon">◇</span>
            <div><strong>Private by design</strong><span>Credentials stay on this device.</span></div>
          </div>
          <span className="config-path" title={state.configPath}>{state.configPath}</span>
        </aside>

        <main className="main-content">
          <div className="page-topline">
            <div className="breadcrumb"><span>MODIO</span><b>/</b><strong>{section === "library" ? "LIBRARY" : "DISCOVER"}</strong></div>
            <div className="top-actions">
              {state.signedIn && <span className="signed-in-pill"><i/> Account connected</span>}
              <button className="icon-button" title="Refresh subscriptions" onClick={() => void refreshSubscriptions()} disabled={busy || !state.signedIn}>↻</button>
            </div>
          </div>

          {section === "library" ? (
            <LibraryPage
              state={state}
              visibleGames={visibleGames}
              selectedGame={selectedGame}
              selectedModsCount={selectedModsCount}
              gameSubscriptions={state.subscriptions.filter((mod) => mod.gameId === selectedGameId)}
              modDetails={modDetailsByGame[selectedGameId] || {}}
              modDetailsLoading={modDetailsLoadingGameId === selectedGameId}
              modDetailsError={modDetailsErrors[selectedGameId] || ""}
              onUnsubscribe={unsubscribe}
              retryPlatforms={() => {
                if (!selectedGame) return;
                setModDetailsByGame((current) => {
                  const next = { ...current };
                  delete next[selectedGame.id];
                  return next;
                });
                setModDetailsRetry((current) => current + 1);
              }}
              gameFilter={gameFilter}
              setGameFilter={setGameFilter}
              setSelectedGameId={setSelectedGameId}
              updateGame={updateGame}
              chooseFolder={chooseFolder}
              syncSelected={syncSelected}
              busy={busy}
              syncing={syncing}
              onDiscover={() => void openDiscover()}
              activity={activity}
            />
          ) : (
            <DiscoverPage
              catalogGames={catalogGames}
              gameQuery={gameQuery}
              searchGames={searchGames}
              gameOffset={gameOffset}
              hasMoreCatalogGames={hasMoreCatalogGames}
              selectedCatalogGame={selectedCatalogGame}
              clearSelectedCatalogGame={() => {
                setSelectedCatalogGame(null);
                setCatalogMods([]);
              }}
              openCatalogGame={openCatalogGame}
              catalogMods={catalogMods}
              catalogTagGroups={catalogTagGroups}
              selectedGameVersion={selectedGameVersion}
              selectedModTagGroup={selectedModTagGroup}
              selectedModTag={selectedModTag}
              selectedPlatformFilter={selectedPlatformFilter}
              setGameVersion={(version) => void searchMods(
                modQuery, false, modSortField, modSortDirection, version, selectedModTagGroup, selectedModTag,
              )}
              setModTagGroup={(group) => void searchMods(
                modQuery, false, modSortField, modSortDirection, selectedGameVersion, group, "",
              )}
              setModTag={(tag) => void searchMods(
                modQuery, false, modSortField, modSortDirection, selectedGameVersion, selectedModTagGroup, tag,
              )}
              setPlatformFilter={(platform) => void searchMods(
                modQuery, false, modSortField, modSortDirection, selectedGameVersion, selectedModTagGroup, selectedModTag, platform,
              )}
              clearModFilters={() => void searchMods(modQuery, false, modSortField, modSortDirection, "", "", "", "")}
              modQuery={modQuery}
              searchMods={searchMods}
              modSortField={modSortField}
              modSortDirection={modSortDirection}
              setModSort={(field, direction) => void searchMods(modQuery, false, field, direction)}
              modOffset={modOffset}
              hasMoreCatalogMods={hasMoreCatalogMods}
              setSelectedMod={setSelectedMod}
              subscribe={subscribe}
              signedIn={state.signedIn}
              busy={busy}
            />
          )}
        </main>
      </div>

      {busy && <div className="busy-indicator"><span className="spinner"/>{busyLabel || "Working…"}</div>}
      {toast && !busy && <div className="toast"><span className="toast-dot"/> {toast}</div>}
      {selectedMod && <ModDetails mod={selectedMod} gameName={selectedCatalogGame?.name || "mod.io game"} onClose={() => setSelectedMod(null)}/>}
      {(appUpdate.status === "available" || appUpdate.status === "downloading" || appUpdate.status === "downloaded"
        || (appUpdate.status === "error" && Boolean(appUpdate.version))) && !updateDismissed && (
        <UpdateDialog
          update={appUpdate}
          onLater={() => setUpdateDismissed(true)}
          onDownload={() => void downloadAppUpdate()}
          onInstall={() => window.modio.installUpdate()}
        />
      )}
    </div>
  );
}

interface LibraryPageProps {
  state: PublicAppState;
  visibleGames: SubscribedGame[];
  selectedGame: SubscribedGame | null;
  selectedModsCount: number;
  gameSubscriptions: PublicAppState["subscriptions"];
  modDetails: Record<string, SubscribedModDetails>;
  modDetailsLoading: boolean;
  modDetailsError: string;
  onUnsubscribe: (modId: string) => Promise<void>;
  retryPlatforms: () => void;
  gameFilter: string;
  setGameFilter: (value: string) => void;
  setSelectedGameId: (value: string) => void;
  updateGame: (input: GameSettingsInput) => Promise<void>;
  chooseFolder: (game: SubscribedGame) => Promise<void>;
  syncSelected: () => Promise<void>;
  busy: boolean;
  syncing: boolean;
  onDiscover: () => void;
  activity: string[];
}

function LibraryPage(props: LibraryPageProps) {
  const selectedCount = props.state.games.filter((game) => game.selected).length;
  return (
    <section className="page-content">
      {!props.selectedGame && <>
      <div className="hero-heading">
        <div>
          <span className="eyebrow accent">YOUR MOD SPACE</span>
          <h1>My library<span className="heading-period">.</span></h1>
          <p>Keep your subscribed mods in sync with the right game folders.</p>
        </div>
        <div className="hero-actions">
          <button className="secondary-button" onClick={props.onDiscover}><span>＋</span> Explore catalog</button>
          <button className="primary-button" onClick={() => void props.syncSelected()} disabled={!props.state.signedIn || selectedCount === 0 || props.busy}>
            {props.syncing ? "Syncing…" : "Sync selected"} <span className="button-arrow">↗</span>
          </button>
        </div>
      </div>

      <div className="stats-row">
        <StatCard label="FOLLOWED MODS" value={props.state.subscriptions.length} icon="◈" tone="mint"/>
        <StatCard label="GAMES IN LIBRARY" value={props.state.games.length} icon="▦" tone="blue"/>
        <StatCard label="READY TO SYNC" value={selectedCount} icon="↻" tone="violet" detail={`${props.selectedModsCount.toLocaleString()} mods selected`}/>
      </div>

      <div className="library-toolbar">
        <div><h2>Connected games</h2><span>{props.visibleGames.length} game{props.visibleGames.length === 1 ? "" : "s"}</span></div>
        <div className="toolbar-actions">
          <label className="search-field"><span>⌕</span><input placeholder="Filter your games…" value={props.gameFilter} onChange={(event) => props.setGameFilter(event.target.value)}/></label>
          <button className="text-button" onClick={() => void updateAll(true)}>Select all</button>
          <button className="text-button" onClick={() => void updateAll(false)}>Clear</button>
        </div>
      </div>
      </>}

      {props.state.games.length === 0 ? (
        <EmptyPanel
          title={props.state.signedIn ? "Your library is waiting" : "Connect your mod.io account"}
          copy={props.state.signedIn
            ? "You have no followed mods yet. Explore the catalog and subscribe to something new."
            : "Sign in to load your subscriptions and start syncing your mods."}
          action={props.state.signedIn ? "Browse mod.io" : undefined}
          onAction={props.onDiscover}
        />
      ) : props.selectedGame ? (
        <GameDetailPage
          game={props.selectedGame}
          mods={props.gameSubscriptions}
          modDetails={props.modDetails}
          modDetailsLoading={props.modDetailsLoading}
          modDetailsError={props.modDetailsError}
          onUnsubscribe={props.onUnsubscribe}
          busy={props.busy}
          retryPlatforms={props.retryPlatforms}
          back={() => props.setSelectedGameId("")}
          chooseFolder={() => props.chooseFolder(props.selectedGame!)}
          update={(settings) => props.updateGame({ gameId: props.selectedGame!.id, ...settings })}
        />
      ) : props.visibleGames.length === 0 ? (
        <EmptyPanel title="No games match" copy="Try another search or clear the filter."/>
      ) : (
        <div className="game-card-grid library-game-grid">
          {props.visibleGames.map((game) => (
            <button
              type="button"
              key={game.id}
              className="game-card"
              onClick={() => props.setSelectedGameId(game.id)}
            >
              <div className="game-cover">
                <Artwork src={game.logoUrl} label={game.name}/>
                <span className="game-mod-badge">{game.modCount} mods</span>
                <span className={`game-check ${game.selected ? "checked" : ""}`} onClick={(event) => {
                  event.stopPropagation();
                  void props.updateGame({ gameId: game.id, selected: !game.selected });
                }}>{game.selected ? "✓" : ""}</span>
              </div>
              <div className="game-card-body">
                <strong>{game.name}</strong>
                <span>{game.targetPath || "Choose an install folder"}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {!props.selectedGame && (
      <section className="activity-section">
        <div className="activity-heading"><div><span className="eyebrow">ACTIVITY</span><h2>Recent updates</h2></div><span className="live-label"><i/> LIVE</span></div>
        <div className="activity-list">
          {props.activity.length ? props.activity.slice(0, 4).map((line, index) => (
            <div className="activity-line" key={`${index}-${line}`}><span className="activity-mark">{index === 0 ? "●" : "·"}</span><span>{line}</span></div>
          )) : <div className="activity-empty">Activity from sign-in, subscriptions, and sync will show here.</div>}
        </div>
      </section>
      )}
    </section>
  );

  async function updateAll(selected: boolean) {
    for (const game of props.state.games) {
      await props.updateGame({ gameId: game.id, selected });
    }
  }
}

function GameDetailPage({ game, mods, modDetails, modDetailsLoading, modDetailsError, onUnsubscribe, busy, retryPlatforms, back, chooseFolder, update }: {
  game: SubscribedGame;
  mods: PublicAppState["subscriptions"];
  modDetails: Record<string, SubscribedModDetails>;
  modDetailsLoading: boolean;
  modDetailsError: string;
  onUnsubscribe: (modId: string) => Promise<void>;
  busy: boolean;
  retryPlatforms: () => void;
  back: () => void;
  chooseFolder: () => Promise<void>;
  update: (settings: Partial<GameSettingsInput>) => Promise<void>;
}) {
  return (
    <section className="game-detail-page">
      <button className="back-button game-detail-back" onClick={back}>← All games</button>
      <header className="game-detail-header">
        <div className="game-detail-cover"><Artwork src={game.logoUrl} label={game.name}/></div>
        <div className="game-detail-heading">
          <span className="eyebrow accent">YOUR SUBSCRIPTIONS</span>
          <h1>{game.name}</h1>
          <p>{mods.length} subscribed {mods.length === 1 ? "mod" : "mods"}</p>
        </div>
        <label className="game-sync-toggle">
          <input type="checkbox" checked={game.selected} onChange={(event) => void update({ selected: event.target.checked })}/>
          <span>{game.selected ? "Included in sync" : "Excluded from sync"}</span>
        </label>
      </header>

      <div className="game-detail-list-heading">
        <div><h2>Subscribed mods</h2><span>{mods.length} mods</span></div>
        {modDetailsLoading && <span className="platform-status">Loading mod details…</span>}
      </div>
      {modDetailsError && (
        <div className="platform-error game-detail-error">
          <span>{modDetailsError}</span>
          <button type="button" onClick={retryPlatforms}>Retry</button>
        </div>
      )}
      {mods.length === 0 ? (
        <div className="game-detail-empty">You haven't subscribed to any mods for this game yet.</div>
      ) : (
        <div className="game-detail-mod-list">
          {mods.map((mod) => {
            const details = modDetails[mod.modId];
            const platforms = details?.platforms || [];
            const platformLabel = platforms.length === 2
              ? "Windows + Android"
              : platforms[0] === "windows"
                ? "Windows"
                : platforms[0] === "android"
                  ? "Android"
                  : "Unknown";
            return (
              <article className="game-detail-mod-row" key={`${mod.gameId}:${mod.modId}`}>
                <div className="game-detail-mod-cover">
                  <Artwork src={details?.logoUrl || null} label={mod.modName}/>
                </div>
                <div className="game-detail-mod-copy">
                  <span className="game-detail-mod-name" title={details?.modName || mod.modName}>
                    {details?.modName || mod.modName}
                  </span>
                  <span className={`mod-platform-badge ${platforms.length ? "" : "unknown"}`}>{platformLabel}</span>
                </div>
                <button
                  type="button"
                  className="unsubscribe-button"
                  disabled={busy}
                  onClick={() => void onUnsubscribe(mod.modId)}
                  aria-label={`Unsubscribe from ${mod.modName}`}
                >
                  Unsubscribe
                </button>
              </article>
            );
          })}
        </div>
      )}

      <details className="game-settings-disclosure">
        <summary>Game settings <span>Install folder, platform and ZIP options</span></summary>
        <GameSettings game={game} chooseFolder={chooseFolder} update={update}/>
      </details>
    </section>
  );
}

function GameSettings({ game, chooseFolder, update }: {
  game: SubscribedGame;
  chooseFolder: () => Promise<void>;
  update: (settings: Partial<GameSettingsInput>) => Promise<void>;
}) {
  return (
    <aside className="game-settings">
      <div className="settings-header"><span className="eyebrow accent">GAME SETTINGS</span><span className="game-id">#{game.id}</span></div>
      <div className="settings-game-title"><div className="settings-mini-cover"><Artwork src={game.logoUrl} label={game.name}/></div><div><h3>{game.name}</h3><span>{game.modCount} subscribed mods</span></div></div>
      <div className="setting-block">
        <label>INSTALL LOCATION</label>
        <button className="folder-picker" onClick={() => void chooseFolder()}><span className="folder-glyph">▱</span><span>{game.targetPath || "Select a mod folder"}</span><b>Browse</b></button>
      </div>
      <div className="setting-block">
        <label>MOD FILE PLATFORM</label>
        <div className="platform-toggle">
          {(["windows", "android"] as Platform[]).map((platform) => (
            <button key={platform} className={game.targetPlatform === platform ? "selected" : ""}
                    onClick={() => void update({ targetPlatform: platform })}>
              <span>{platform === "windows" ? "▣" : "▤"}</span>{platform === "windows" ? "Windows" : "Android"}
            </button>
          ))}
        </div>
      </div>
      <label className="switch-row"><span><strong>Extract ZIP archives</strong><small>Unpack mods into the install folder</small></span><input type="checkbox" checked={game.extractArchives} onChange={(event) => void update({ extractArchives: event.target.checked })}/><i/></label>
      <label className="switch-row"><span><strong>Include in sync</strong><small>Download this game's subscriptions</small></span><input type="checkbox" checked={game.selected} onChange={(event) => void update({ selected: event.target.checked })}/><i/></label>
    </aside>
  );
}

interface DiscoverPageProps {
  catalogGames: CatalogGame[];
  gameQuery: string;
  searchGames: (query?: string, append?: boolean) => Promise<void>;
  gameOffset: number;
  hasMoreCatalogGames: boolean;
  selectedCatalogGame: CatalogGame | null;
  clearSelectedCatalogGame: () => void;
  openCatalogGame: (game: CatalogGame) => Promise<void>;
  catalogMods: CatalogMod[];
  catalogTagGroups: CatalogTagGroup[];
  selectedGameVersion: string;
  selectedModTagGroup: string;
  selectedModTag: string;
  selectedPlatformFilter: Platform | "";
  setGameVersion: (version: string) => void;
  setModTagGroup: (group: string) => void;
  setModTag: (tag: string) => void;
  setPlatformFilter: (platform: Platform | "") => void;
  clearModFilters: () => void;
  modQuery: string;
  searchMods: (query?: string, append?: boolean) => Promise<void>;
  modSortField: ModSortField;
  modSortDirection: SortDirection;
  setModSort: (field: ModSortField, direction: SortDirection) => void;
  modOffset: number;
  hasMoreCatalogMods: boolean;
  setSelectedMod: (mod: CatalogMod) => void;
  subscribe: (mod: CatalogMod) => Promise<void>;
  signedIn: boolean;
  busy: boolean;
}

function DiscoverPage(props: DiscoverPageProps) {
  const [gameInput, setGameInput] = useState(props.gameQuery);
  const [modInput, setModInput] = useState(props.modQuery);
  const gameVersionGroup = props.catalogTagGroups.find((group) => group.name.toLocaleLowerCase().includes("version"));
  const modTagGroups = props.catalogTagGroups.filter((group) => group !== gameVersionGroup);
  const selectedTagGroup = modTagGroups.find((group) => group.name === props.selectedModTagGroup);
  useEffect(() => setGameInput(props.gameQuery), [props.gameQuery]);
  useEffect(() => setModInput(props.modQuery), [props.modQuery]);

  return (
    <section className="page-content discover-page">
      <div className="hero-heading discover-hero">
        <div><span className="eyebrow accent">THE MOD.IO COMMUNITY</span><h1>Discover<span className="heading-period">.</span></h1>
          <p>Find a game, explore its creations, and follow the mods you love.</p></div>
        <div className="catalog-note"><span>✦</span><div><strong>Community made</strong><small>Powered by the mod.io catalog</small></div></div>
      </div>

      {!props.selectedCatalogGame ? (
        <>
          <div className="discover-search-bar">
            <label className="search-field large"><span>⌕</span><input value={gameInput} onChange={(event) => setGameInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void props.searchGames(gameInput, false); }}
              placeholder="Search games on mod.io…"/></label>
            <button className="primary-button" disabled={props.busy} onClick={() => void props.searchGames(gameInput, false)}>Search games <span>↗</span></button>
          </div>
          <div className="section-title-row"><div><h2>Popular games</h2><span>Pick a game to see its mod catalog</span></div><span className="result-count">{props.catalogGames.length} results</span></div>
          {props.catalogGames.length ? (
            <div className="catalog-game-grid">
              {props.catalogGames.map((game) => (
                <button type="button" className="catalog-game-card" key={game.id} onClick={() => void props.openCatalogGame(game)}>
                  <div className="catalog-cover"><Artwork src={game.logoUrl} label={game.name}/><span className="cover-arrow">↗</span></div>
                  <div className="catalog-game-info"><strong>{game.name}</strong><span>{game.modCount.toLocaleString()} mods <b>·</b> {truncate(game.summary || "Explore community mods", 58)}</span></div>
                </button>
              ))}
            </div>
          ) : <EmptyPanel title="Browse the mod.io catalog" copy="Search for a game to discover its mods and community."/>}
          {props.hasMoreCatalogGames &&
            <button className="load-more-button" disabled={props.busy} onClick={() => void props.searchGames(gameInput, true)}>Load more games <span>↓</span></button>}
        </>
      ) : (
        <>
          <div className="catalog-back-row">
            <button className="back-button" onClick={props.clearSelectedCatalogGame}>← All games</button>
            <div className="selected-catalog-game"><div className="selected-game-thumb"><Artwork src={props.selectedCatalogGame.logoUrl} label={props.selectedCatalogGame.name}/></div>
              <div><span className="eyebrow">BROWSING GAME</span><strong>{props.selectedCatalogGame.name}</strong></div></div>
            <span className="result-count">{props.selectedCatalogGame.modCount.toLocaleString()} mods available</span>
          </div>
          <div className="discover-search-bar mods-search-bar">
            <label className="search-field large"><span>⌕</span><input value={modInput} onChange={(event) => setModInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void props.searchMods(modInput, false); }}
              placeholder={`Search ${props.selectedCatalogGame.name} mods…`}/></label>
            <button className="primary-button" disabled={props.busy} onClick={() => void props.searchMods(modInput, false)}>Search mods <span>↗</span></button>
          </div>
          <div className="mod-sort-controls">
            <label>
              <span>Platform</span>
              <select value={props.selectedPlatformFilter} disabled={props.busy}
                      onChange={(event) => props.setPlatformFilter(event.target.value as Platform | "")}>
                <option value="">All platforms</option>
                <option value="windows">Windows</option>
                <option value="android">Android</option>
              </select>
            </label>
            {gameVersionGroup && (
              <label>
                <span>Game version</span>
                <select value={props.selectedGameVersion} disabled={props.busy}
                        onChange={(event) => props.setGameVersion(event.target.value)}>
                  <option value="">All versions</option>
                  {gameVersionGroup.tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                </select>
              </label>
            )}
            {modTagGroups.length > 0 && (
              <>
                <label>
                  <span>Tag group</span>
                  <select value={props.selectedModTagGroup} disabled={props.busy}
                          onChange={(event) => props.setModTagGroup(event.target.value)}>
                    <option value="">All tag groups</option>
                    {modTagGroups.map((group) => <option key={group.name} value={group.name}>{group.name}</option>)}
                  </select>
                </label>
                {selectedTagGroup && (
                  <label>
                    <span>{selectedTagGroup.name}</span>
                    <select value={props.selectedModTag} disabled={props.busy}
                            onChange={(event) => props.setModTag(event.target.value)}>
                      <option value="">All</option>
                      {selectedTagGroup.tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                    </select>
                  </label>
                )}
              </>
            )}
            {!gameVersionGroup && (
              <span className="filter-empty-note">No game-version tags are configured for this game.</span>
            )}
            <label>
              <span>Sort by</span>
              <select value={props.modSortField} disabled={props.busy} onChange={(event) =>
                {
                  const field = parseModSortField(event.target.value);
                  if (field) props.setModSort(field, props.modSortDirection);
                }}>
                <option value="popular">Popularity</option>
                <option value="rating">Likes / rating</option>
                <option value="downloads">Downloads</option>
                <option value="subscribers">Favorites / subscriptions</option>
              </select>
            </label>
            <label>
              <span>Order</span>
              <select value={props.modSortDirection} disabled={props.busy} onChange={(event) =>
                {
                  const direction = parseSortDirection(event.target.value);
                  if (direction) props.setModSort(props.modSortField, direction);
                }}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
            <button type="button" className="clear-filters-button" disabled={props.busy
              || (!props.selectedGameVersion && !props.selectedModTag && !props.selectedPlatformFilter)}
                    onClick={props.clearModFilters}>Clear filters</button>
          </div>
          <div className="section-title-row"><div><h2>Community mods</h2><span>Tap a mod for details · subscribe to add it to your library</span></div><span className="result-count">{props.catalogMods.length} shown</span></div>
          {props.catalogMods.length ? (
            <div className="mod-card-grid">
              {props.catalogMods.map((mod) => (
                <article className="mod-card" key={mod.id}>
                  <button className="mod-card-open" onClick={() => props.setSelectedMod(mod)} aria-label={`Details for ${mod.name}`}>
                    <div className="mod-cover"><Artwork src={mod.logoUrl} label={mod.name}/><span className="details-hint">VIEW DETAILS ↗</span></div>
                    <div className="mod-name" title={mod.name}>{mod.name}</div>
                  </button>
                  <button className={`subscribe-button ${mod.isSubscribed ? "subscribed" : ""}`}
                          disabled={mod.isSubscribed || !props.signedIn || props.busy}
                          onClick={() => void props.subscribe(mod)}>
                    {mod.isSubscribed ? <><span>✓</span> Subscribed</> : props.signedIn ? "Subscribe" : "Sign in to subscribe"}
                  </button>
                </article>
              ))}
            </div>
          ) : <EmptyPanel title="No mods found" copy="Try a different search, or choose another game."/>}
          {props.hasMoreCatalogMods &&
            <button className="load-more-button" disabled={props.busy} onClick={() => void props.searchMods(modInput, true)}>Load more mods <span>↓</span></button>}
        </>
      )}
    </section>
  );
}

function ModDetails({ mod, gameName, onClose }: { mod: CatalogMod; gameName: string; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="mod-details-modal" role="dialog" aria-modal="true" aria-label={`${mod.name} details`}>
        <button className="modal-close" aria-label="Close details" onClick={onClose}>×</button>
        <div className="modal-cover"><Artwork src={mod.logoUrl} label={mod.name}/></div>
        <span className="eyebrow accent">MOD DETAILS <b>·</b> {gameName}</span>
        <h2>{mod.name}</h2>
        <p>{mod.summary || "No description was provided for this mod."}</p>
        <div className="modal-stats"><StatCard label="DOWNLOADS" value={mod.downloads} icon="↓" tone="blue"/><StatCard label="SUBSCRIBERS" value={mod.subscribers} icon="◈" tone="mint"/></div>
      </section>
    </div>
  );
}

function UpdateDialog({ update, onLater, onDownload, onInstall }: {
  update: AppUpdateState;
  onLater: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const isDownloading = update.status === "downloading";
  const isDownloaded = update.status === "downloaded";
  const canRetry = update.status === "error" && Boolean(update.version);
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div className="update-icon">↑</div>
        <span className="eyebrow accent">UPDATE AVAILABLE</span>
        <h2 id="update-title">Modio Manager {update.version}</h2>
        <p className="update-description">
          {isDownloaded
            ? "The update is ready. Restart the app to install it."
            : isDownloading
              ? "Downloading the update. You can keep using the app."
              : canRetry
                ? "The update download failed. You can try again."
                : "A newer version is ready to install. Would you like to update now?"}
        </p>
        {isDownloading && (
          <div className="update-progress">
            <div className="update-progress-track"><span style={{ width: `${Math.min(100, Math.max(0, update.percent || 0))}%` }}/></div>
            <span>{Math.floor(update.percent || 0)}%</span>
          </div>
        )}
        {update.releaseNotes && (
          <div className="update-notes">
            <strong>What’s new</strong>
            <p>{update.releaseNotes}</p>
          </div>
        )}
        <div className="update-actions">
          {!isDownloaded && (
            <button type="button" className="text-button" onClick={onLater}>
              {isDownloading ? "Run in background" : "Later"}
            </button>
          )}
          {isDownloaded ? (
            <button type="button" className="primary-button" onClick={onInstall}>Restart &amp; install</button>
          ) : isDownloading ? (
            <button type="button" className="primary-button" disabled>Downloading…</button>
          ) : (
            <button type="button" className="primary-button" onClick={onDownload}>
              {canRetry ? "Retry download" : "Download and install"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, icon, tone, detail }: { label: string; value: number; icon: string; tone: string; detail?: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div className="stat-copy"><span>{label}</span><strong>{value.toLocaleString()}</strong>{detail && <small>{detail}</small>}</div></div>;
}

function Artwork({ src, label }: { src: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <><span className="artwork-fallback">{label.slice(0, 1).toUpperCase()}</span>
    {src && !failed && <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}/>}</>;
}

function EmptyPanel({ title, copy, action, onAction }: { title: string; copy: string; action?: string; onAction?: () => void }) {
  return <div className="empty-panel"><div className="empty-symbol">✳</div><h3>{title}</h3><p>{copy}</p>
    {action && <button className="secondary-button" onClick={onAction}>{action} <span>↗</span></button>}</div>;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function parseModSortField(value: string): ModSortField | null {
  if (value === "popular" || value === "rating" || value === "downloads" || value === "subscribers") return value;
  return null;
}

function parseSortDirection(value: string): SortDirection | null {
  if (value === "asc" || value === "desc") return value;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
