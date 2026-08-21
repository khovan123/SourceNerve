import { Download, FileText, PackageOpen } from "lucide-react";

import type { SupportBundleExportFormat, SupportBundlePreview } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { EmptyState } from "../molecules/EmptyState";
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
    <SurfaceCard
      title="Support bundle"
      description="Preview sanitized local diagnostics before exporting them for support."
    >
      <div className="space-y-4">
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
              <span>{formatBytes(preview.bytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(preview.generatedAt).toLocaleString()}</span>
            </div>
            <pre className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#e9dfd2] dark:bg-black/40" aria-label="Exact support bundle preview" tabIndex={0}>{preview.text}</pre>
          </>
        ) : (
          <EmptyState title="No preview yet" description="Generate a preview before exporting a support bundle." compact />
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
