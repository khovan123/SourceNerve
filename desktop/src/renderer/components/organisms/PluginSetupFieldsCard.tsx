import { Copy, ExternalLink, ImageDown } from "lucide-react";

import type { PluginSetupFields } from "../../../shared/plugin-verification-api";
import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function PluginSetupFieldsCard({
  fields,
  mcpServerUrl,
  busy,
  onCopy,
  onOpenChatGpt,
  onExportIcon,
}: {
  fields: PluginSetupFields;
  mcpServerUrl?: string;
  busy: string | null;
  onCopy(): void;
  onOpenChatGpt(): void;
  onExportIcon(): void;
}) {
  return (
    <SurfaceCard title="ChatGPT setup fields" eyebrow="Manual plugin connection">
      <div className="space-y-4">
        <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          <Field label="Name" value={fields.name} />
          <Field label="Description" value={fields.description} />
          <Field label="MCP Server URL" value={mcpServerUrl ?? "Unavailable — repair Public MCP first"} mono wide />
          <Field label="OAuth issuer" value={fields.oauthIssuer} mono />
          <Field label="OAuth resource" value={fields.oauthResource} mono />
          <Field label="OAuth scopes" value={fields.oauthScopes.join(" ")} mono wide />
          <Field label="Privacy" value={fields.privacyUrl} mono />
          <Field label="Terms" value={fields.termsUrl} mono />
          <Field label="Support" value={fields.supportUrl} mono />
          {fields.iconUrl ? <Field label="Icon" value={fields.iconUrl} mono /> : null}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border/70 pt-4">
          <ActionButton variant="secondary" size="sm" disabled={!mcpServerUrl || busy === "copy"} onClick={onCopy}>
            <Copy className="size-3.5" aria-hidden="true" />
            {busy === "copy" ? "Copying…" : "Copy setup fields"}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" disabled={busy === "open"} onClick={onOpenChatGpt}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Open ChatGPT setup
          </ActionButton>
          <ActionButton variant="ghost" size="sm" disabled={busy === "icon"} onClick={onExportIcon}>
            <ImageDown className="size-3.5" aria-hidden="true" />
            {busy === "icon" ? "Exporting…" : "Export icon"}
          </ActionButton>
        </div>
      </div>
    </SurfaceCard>
  );
}

function Field({ label, value, mono = false, wide = false }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`min-w-0 bg-card px-3 py-3 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs leading-5 text-foreground ${mono ? "font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
