/** The bridge host script (client/public/app-bridge-host.js) is loaded by
 *  index.html before the bundle; this is its contract. */
declare global {
  interface Window {
    ChrysalisBridgeHost: {
      frameSrc(appId: string, username: string): string;
      serve(iframe: HTMLIFrameElement, appId: string, username: string, trusted?: boolean): () => void;
      allowedRequest(appId: string, method: string, path: string, trusted?: boolean): boolean;
      eventAllowed(appId: string, trusted: boolean, raw: string): boolean;
      storageKey(username: string, appId: string): string;
    };
    /** In-browser app builder (src/builder/browser/host.ts, /client/builder/host.js). */
    ChrysalisBuilder?: {
      watch(
        appId: string,
        onStatus: (s: AppBuildStatus) => void,
        onReload: () => void,
      ): { ready: Promise<void>; dispose(): void };
      rebuild(appId: string): Promise<void>;
    };
  }
  interface AppBuildStatus {
    phase: "checking" | "building" | "ready" | "error" | "waiting";
    message?: string;
    errors?: Array<{ text: string; file?: string; line?: number; column?: number; lineText?: string }>;
  }
}

export {};
