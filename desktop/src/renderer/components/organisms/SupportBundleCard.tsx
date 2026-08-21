import { Download, FileText, PackageOpen } from "lucide-react";

import type { SupportBundleExportFormat, SupportBundlePreview } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function SupportBundleCard({
  preview,
  busy,
  onGenerate,
  onExport,
}: {
  preview: SupportBundlePreview | null;
  busy: string | null;
  onGenerate(): void;
  onExport(format: SupportBundleExportFormat): void;
}) {
  return (
    <SurfaceCard title="Support bundle" eyebrow="Preview before export">
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Generated locally and usable offline. The bundle contains status/config shape, hashed state locations and bounded sanitized logs — never tokens, Authorization headers, source bodies, patch bodies or repository diffs.
        </p>
        <div className="flex flex-wrap gap-2">
          <ActionButton size="sm" disabled={busy !== null} onClick={onGenerate}>
            <FileText className="size-3.5" aria-hidden="true" />
            {busy === "preview" ? "Generating…" : preview ? "Refresh preview" : "Generate preview"}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" disabled={!preview || busy !== null} onClick={() => onExport("text")}>
            <Download className="size-3.5" aria-hidden="true" />
            Export TXT
          </ActionButton>
          <ActionButton variant="secondary" size="sm" disabled={!preview || busy !== null} onClick={() => onExport("zip")}>
            <PackageOpen className="size-3.5" aria-hidden="true" />
            Export ZIP
          </ActionButton>
        </div>

        {preview ? (
          <>
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span className="rounded-full border border-border bg-muted/35 px-2.5 py-1">{formatBytes(preview.bytes)}</span>
              <span className="rounded-full border border-border bg-muted/35 px-2.5 py-1">SHA-256 {preview.sha256.slice(0, 16)}…</span>
              <span className="rounded-full border border-border bg-muted/35 px-2.5 py-1">{new Date(preview.generatedAt).toLocaleString()}</span>
            </div>
            <pre className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#e9dfd2] dark:bg-black/40" aria-label="Exact support bundle preview">{preview.text}</pre>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
            <strong className="text-sm text-foreground">No support bundle prepared.</strong>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Generate a preview first; export always uses that exact one-shot snapshot.</p>
          </div>
        )}
      </div>
    </SurfaceCard>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
