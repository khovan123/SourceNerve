import type { PropsWithChildren, ReactNode } from "react";

import { SurfaceCard } from "./molecules/SurfaceCard";

interface PanelProps extends PropsWithChildren {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
}

export function Panel({ title, eyebrow, actions, children }: PanelProps) {
  return <SurfaceCard title={title} eyebrow={eyebrow} actions={actions}>{children}</SurfaceCard>;
}
