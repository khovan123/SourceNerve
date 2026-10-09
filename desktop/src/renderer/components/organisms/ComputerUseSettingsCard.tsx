import type { ReactNode } from "react";
import { Clipboard, Keyboard, MonitorUp, MousePointer2, ShieldCheck } from "lucide-react";

import type { DesktopControlCapability, DesktopControlPermissions, DesktopControlState } from "../../../shared/desktop-api";
import { ToggleSwitch } from "../atoms/ToggleSwitch";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function ComputerUseSettingsCard({
  state,
  loading,
  saving,
  error,
  onComputerUse,
  onCapability,
}: {
  state: DesktopControlState | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onComputerUse(enabled: boolean): void;
  onCapability(capability: DesktopControlCapability, enabled: boolean): void;
}) {
  const permissions = state?.permissions ?? DISABLED;
  const disabled = loading || saving;
  const computerUseEnabled = permissions.screen && permissions.mouse && permissions.keyboard;
  const inputReady = Boolean(state?.inputBackend.mouse && state?.inputBackend.keyboard);
  const routable = computerUseEnabled && inputReady;

  return (
    <SurfaceCard
      title="Computer Use"
      description="Allow ChatGPT/Codex to use local desktop capabilities you explicitly enable. Background native controls are preferred so your active mouse, keyboard, and focus stay yours."
    >
      <div className="divide-y divide-border/70" aria-busy={disabled}>
        <SettingRow
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
          title="Enable full computer use"
          description="Turns on screen, mouse, and keyboard permissions together. These local permissions are persistent consent, so SourceNerve will not ask again for every click or key; protected remote/provider actions keep their own approval rules."
          control={(
            <ToggleSwitch
              label="Enable full computer use"
              checked={computerUseEnabled}
              disabled={disabled}
              onChange={onComputerUse}
            />
          )}
        />
        <SettingRow
          icon={<MonitorUp className="size-4" aria-hidden="true" />}
          title="Screen observation"
          description="Lets the desktop host capture screen/window thumbnails so the agent can see where to interact."
          control={<ToggleSwitch label="Allow screen observation" checked={permissions.screen} disabled={disabled} onChange={(enabled) => onCapability("screen", enabled)} />}
        />
        <SettingRow
          icon={<MousePointer2 className="size-4" aria-hidden="true" />}
          title="Mouse control"
          description={`Foreground fallback only. It moves your real pointer when no background/semantic control exists. Backend: ${state?.inputBackend.id ?? "checking"}.`}
          control={<ToggleSwitch label="Allow mouse control" checked={permissions.mouse} disabled={disabled} onChange={(enabled) => onCapability("mouse", enabled)} />}
        />
        <SettingRow
          icon={<Keyboard className="size-4" aria-hidden="true" />}
          title="Keyboard control"
          description="Foreground fallback only. It types into the currently focused app and may interrupt you, so agents should prefer background semantic controls."
          control={<ToggleSwitch label="Allow keyboard control" checked={permissions.keyboard} disabled={disabled} onChange={(enabled) => onCapability("keyboard", enabled)} />}
        />
        <SettingRow
          icon={<Clipboard className="size-4" aria-hidden="true" />}
          title="Clipboard"
          description="Optional clipboard read/write access. It is not required for mouse and keyboard computer use."
          control={<ToggleSwitch label="Allow clipboard access" checked={permissions.clipboard} disabled={disabled} onChange={(enabled) => onCapability("clipboard", enabled)} />}
        />
      </div>

      {error ? (
        <div className="mt-4"><InlineNotice tone="danger" title="Computer use is unavailable" role="alert">{error}</InlineNotice></div>
      ) : state && computerUseEnabled && !inputReady ? (
        <div className="mt-4"><InlineNotice tone="warning" title="Native input backend is not ready">{state.inputBackend.notes.join(" ") || "Install or configure a supported native input backend before mouse and keyboard tools can become routable."}</InlineNotice></div>
      ) : state && routable ? (
        <div className="mt-4"><InlineNotice tone="success" title="Computer use host is ready">The desktop host is ready. SourceNerve will prefer background native controls and use real pointer/keyboard injection only as a foreground fallback.</InlineNotice></div>
      ) : null}
    </SurfaceCard>
  );
}

const DISABLED: DesktopControlPermissions = {
  screen: false,
  mouse: false,
  keyboard: false,
  clipboard: false,
};

function SettingRow({ icon, title, description, control }: { icon: ReactNode; title: string; description: string; control: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/45 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="mt-1 max-w-2xl text-[11px] leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="shrink-0 sm:pl-4">{control}</div>
    </div>
  );
}
