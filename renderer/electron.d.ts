import type { ModioDesktopApi } from "../electron/types";

declare global {
  interface Window {
    modio: ModioDesktopApi;
  }
}

export {};
