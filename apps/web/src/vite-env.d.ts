interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";

declare module "virtual:pwa-register/react" {
  interface RegisterSWOptions {
    readonly immediate?: boolean;
    readonly onRegisterError?: (error: unknown) => void;
  }

  type BooleanState = readonly [boolean, (value: boolean) => void];

  interface RegisterSWResult {
    readonly needRefresh: BooleanState;
    readonly offlineReady: BooleanState;
    readonly updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  }

  export function useRegisterSW(options?: RegisterSWOptions): RegisterSWResult;
}
