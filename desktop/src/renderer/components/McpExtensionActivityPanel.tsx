import { useEffect, useState } from "react";

import type {
  McpExtensionActivityView,
  McpExtensionView,
} from "../../shared/mcp-extension-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";
import { Panel } from "./Panel";

const ACTIVITY_LIMIT = 100;

export function McpExtensionActivityPanel({
  extensions = [],
}: {
  extensions?: McpExtensionView[];
}) {
  const [activity, setActivity] = useState<McpExtensionActivityView[]>([]);
  const [selectedExtension, setSelectedExtension] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshActivity(selectedExtension);
  }, [selectedExtension]);

  async function refreshActivity(extensionId = selectedExtension): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await window.sourcenerveMcpExtensions.listActivity({
        ...(extensionId ? { extensionId } : {}),
        limit: ACTIVITY_LIMIT,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setActivity(result.value);
    } catch (activityError) {
      setError(
        activityError instanceof Error && activityError.message
          ? activityError.message
          : "Recent MCP activity could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel
      title="Recent MCP activity"
      eyebrow="Safe invocation audit"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {extensions.length > 0 ? (
            <select
              aria-label="Filter MCP activity by extension"
              className="h-9 min-w-44 rounded-xl border border-border bg-background px-3 text-xs text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
              value={selectedExtension}
              onChange={(event) => setSelectedExtension(event.target.value)}
            >
              <option value="">All extensions</option>
              {extensions.map((extension) => (
                <option key={extension.id} value={extension.id}>
                  {extension.name}
                </option>
              ))}
            </select>
          ) : null}
          <ActionButton
            size="sm"
            variant="secondary"
            disabled={loading}
            onClick={() => void refreshActivity()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </ActionButton>
        </div>
      }
    >
      <p className="text-xs text-muted-foreground">
        SourceNerve keeps bounded invocation metadata only. Tool arguments, results, credentials,
        access tokens, refresh tokens and authorization headers are not returned to the Renderer.
      </p>

      {error ? (
        <div className="mt-3">
          <InlineNotice tone="danger" title="MCP activity unavailable" role="alert">
            {error}
          </InlineNotice>
        </div>
      ) : null}

      {!error && activity.length === 0 ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
          {loading ? "Loading recent activity…" : "No downstream MCP invocations recorded yet."}
        </div>
      ) : null}

      {activity.length > 0 ? (
        <div className="mt-4 space-y-2">
          {activity.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function ActivityRow({ item }: { item: McpExtensionActivityView }) {
  const status = activityStatus(item);
  const error = activityErrorPresentation(item.errorCategory);
  return (
    <article className="rounded-xl border border-border/70 bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ActivityBadge className={status.className}>{status.label}</ActivityBadge>
            {item.approvalDecision === "approved" ? (
              <ActivityBadge className="text-success">approved</ActivityBadge>
            ) : null}
            {item.policyDecision === "blocked" ? (
              <ActivityBadge className="text-danger">blocked</ActivityBadge>
            ) : null}
            <code className="break-all text-xs font-semibold text-foreground">
              {item.publicTool}
            </code>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.extensionId} · v{item.extensionVersion} · {principalLabel(item)}
            {item.workspaceId ? ` · workspace ${item.workspaceId}` : ""}
          </p>
        </div>
        <time className="shrink-0 text-[11px] text-muted-foreground">
          {formatActivityTime(item.occurredAt)}
        </time>
      </div>

      <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
        <ActivityMetric label="Policy" value={item.policyDecision} />
        <ActivityMetric label="Approval" value={item.approvalDecision} />
        <ActivityMetric label="Duration" value={`${item.durationMs} ms`} />
        <ActivityMetric label="Schema" value={shortHash(item.schemaHash)} />
      </div>

      {error ? (
        <div className="mt-2 space-y-1 text-xs text-danger">
          <p>Error category: {error.category}</p>
          {error.previousFailure ? <p>Previous failure: {error.previousFailure}</p> : null}
          {error.guidance ? (
            <p className="text-muted-foreground">{error.guidance}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ActivityMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 px-2.5 py-2">
      <span className="block text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <span className="mt-0.5 block break-all text-foreground">{value}</span>
    </div>
  );
}

function ActivityBadge({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}) {
  return (
    <span className={`rounded-full border border-border bg-card px-2 py-0.5 text-[10px] ${className}`}>
      {children}
    </span>
  );
}

function activityStatus(item: McpExtensionActivityView): {
  label: string;
  className: string;
} {
  if (item.errorCategory?.startsWith("runtime-fail-closed")) {
    return { label: "runtime stopped", className: "text-danger" };
  }
  switch (item.resultCategory) {
    case "success":
      return { label: "success", className: "text-success" };
    case "approval-required":
      return { label: "approval required", className: "text-foreground" };
    case "denied":
      return { label: "denied", className: "text-danger" };
    case "configuration-error":
      return { label: "configuration error", className: "text-danger" };
    case "downstream-error":
      return { label: "downstream error", className: "text-danger" };
  }
}

export function activityErrorPresentation(errorCategory?: string): {
  category: string;
  previousFailure?: string;
  guidance?: string;
} | null {
  if (!errorCategory) return null;
  const prefix = "runtime-fail-closed";
  if (errorCategory === prefix) {
    return {
      category: prefix,
      guidance: "Extension stopped after repeated failures. Restart or re-enable it before retrying.",
    };
  }
  if (errorCategory.startsWith(`${prefix}:`)) {
    const previousFailure = errorCategory.slice(prefix.length + 1);
    return {
      category: prefix,
      ...(previousFailure ? { previousFailure } : {}),
      guidance: "Extension stopped after repeated failures. Restart or re-enable it before retrying.",
    };
  }
  return { category: errorCategory };
}

function principalLabel(item: McpExtensionActivityView): string {
  return item.principalKind === "operator"
    ? "local operator"
    : `OAuth ${item.principalSubject}`;
}

function formatActivityTime(value: number): string {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}
