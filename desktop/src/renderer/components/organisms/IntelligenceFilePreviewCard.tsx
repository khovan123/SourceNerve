import { FileCode2, X } from "lucide-react";

import type { IntelligenceFilePreview } from "../../../shared/intelligence-api";
import { ActionButton } from "../atoms/ActionButton";
import { CodeSurface } from "../molecules/CodeSurface";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function IntelligenceFilePreviewCard({ preview, onClose }: { preview: IntelligenceFilePreview; onClose(): void }) {
  return (
    <div className="relative z-30 xl:fixed xl:bottom-12 xl:right-4 xl:top-20 xl:w-[min(46vw,760px)]" role="region" aria-label={`File preview ${preview.path}`}>
      <SurfaceCard
        title={preview.path}
        eyebrow={`File detail · lines ${preview.startLine}-${preview.endLine}`}
        description="Read-only bounded preview from the selected SourceNerve workspace."
        className="overflow-hidden shadow-[0_30px_90px_rgba(20,18,15,0.22)] xl:flex xl:max-h-full xl:flex-col"
        actions={<ActionButton variant="ghost" size="icon" onClick={onClose} aria-label="Close file preview"><X className="size-4" aria-hidden="true" /></ActionButton>}
      >
        <div className="space-y-3 xl:min-h-0 xl:flex-1">
          <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-muted/25 px-3 py-2">
            <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="select-all break-all text-[10px] leading-4 text-muted-foreground">SHA-256 {preview.sha256}</code>
          </div>
          <CodeSurface
            title={preview.path}
            meta={`L${preview.startLine}–${preview.endLine}`}
            maxHeightClass="max-h-[52vh] xl:max-h-[calc(100vh-17rem)]"
          >
            {preview.content || "(empty file/range)"}
          </CodeSurface>
          <p className="text-[10px] leading-4 text-muted-foreground xl:hidden">On wider windows this preview stays pinned as a detail pane while you continue exploring results.</p>
        </div>
      </SurfaceCard>
    </div>
  );
}
