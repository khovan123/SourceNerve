import { FileCode2, X } from "lucide-react";

import type { IntelligenceFilePreview } from "../../../shared/intelligence-api";
import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function IntelligenceFilePreviewCard({ preview, onClose }: { preview: IntelligenceFilePreview; onClose(): void }) {
  return (
    <SurfaceCard
      title={preview.path}
      eyebrow={`Explicit file preview · lines ${preview.startLine}-${preview.endLine}`}
      actions={<ActionButton variant="ghost" size="icon" onClick={onClose} aria-label="Close file preview"><X className="size-4" aria-hidden="true" /></ActionButton>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/25 px-3 py-2">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <code className="break-all text-[10px] text-muted-foreground">SHA-256 {preview.sha256}</code>
        </div>
        <pre className="max-h-[44rem] overflow-auto rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#f2eadf] dark:bg-black/40"><code>{preview.content || "(empty file/range)"}</code></pre>
      </div>
    </SurfaceCard>
  );
}
