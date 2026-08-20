import type {
  Auth0Identity,
  Auth0WorkspaceGrant,
  DesktopResult,
  PublicMcpView,
} from "./desktop-api";

export const PLUGIN_VERIFICATION_IPC = {
  state: "desktop:plugin-verification-state",
  verify: "desktop:plugin-verification-run",
  copyFields: "desktop:plugin-verification-copy-fields",
  openChatGpt: "desktop:plugin-verification-open-chatgpt",
  exportIcon: "desktop:plugin-verification-export-icon",
  challengeSet: "desktop:plugin-domain-challenge-set",
  challengeVerify: "desktop:plugin-domain-challenge-verify",
  challengeRemove: "desktop:plugin-domain-challenge-remove",
} as const;

export type PluginCheckState = "ready" | "warning" | "error" | "not-checked";

export interface PluginVerificationCheck {
  id: string;
  label: string;
  state: PluginCheckState;
  message: string;
}

export interface PluginSetupFields {
  name: string;
  description: string;
  publicMcpResource: string;
  oauthIssuer: string;
  oauthResource: string;
  oauthScopes: string[];
  privacyUrl: string;
  termsUrl: string;
  supportUrl: string;
  iconUrl?: string;
  chatgptSetupUrl?: string;
}

export interface PluginVerificationView {
  status: "ready-to-connect" | "connected-ready" | "needs-attention";
  account: {
    status: string;
    identity?: Auth0Identity;
    workspaceGrants: Auth0WorkspaceGrant[];
  };
  publicMcp: PublicMcpView;
  fields: PluginSetupFields;
  checks: PluginVerificationCheck[];
  challenge: {
    configured: boolean;
    verified: boolean;
    lastVerifiedAt?: string;
  };
  lastVerifiedAt?: string;
}

export interface PluginVerificationRunResult {
  view: PluginVerificationView;
  toolCount?: number;
  serverName?: string;
  serverVersion?: string;
}

export interface PluginCopyResult {
  copied: true;
  characters: number;
}

export interface PluginOpenResult {
  opened: true;
}

export interface PluginIconExportResult {
  saved: boolean;
  bytes: number;
}

export interface PluginDomainChallengeInput {
  token: string;
}

export interface PluginDomainChallengeResult {
  configured: boolean;
  verified: boolean;
  lastVerifiedAt?: string;
  message: string;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    getPluginVerificationState(): Promise<DesktopResult<PluginVerificationView>>;
    verifyPluginConnection(): Promise<DesktopResult<PluginVerificationRunResult>>;
    copyPluginSetupFields(): Promise<DesktopResult<PluginCopyResult>>;
    openChatGptPluginSetup(): Promise<DesktopResult<PluginOpenResult>>;
    exportPluginIcon(): Promise<DesktopResult<PluginIconExportResult>>;
    setPluginDomainChallenge(input: PluginDomainChallengeInput): Promise<DesktopResult<PluginDomainChallengeResult>>;
    verifyPluginDomainChallenge(): Promise<DesktopResult<PluginDomainChallengeResult>>;
    removePluginDomainChallenge(): Promise<DesktopResult<PluginDomainChallengeResult>>;
  }
}
