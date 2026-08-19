import type { PropsWithChildren, ReactNode } from "react";

interface PanelProps extends PropsWithChildren {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
}

export function Panel({ title, eyebrow, actions, children }: PanelProps) {
  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
        </div>
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
