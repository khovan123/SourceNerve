import { Plus } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";

export function WorkspaceManagerHeader({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd(): void;
}) {
  return (
    <div className="flex justify-end">
      <ActionButton disabled={busy} onClick={onAdd}>
        <Plus className="size-4" aria-hidden="true" />
        Add new workspace
      </ActionButton>
    </div>
  );
}
