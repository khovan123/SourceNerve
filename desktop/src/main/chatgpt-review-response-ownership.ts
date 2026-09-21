export interface ChatGptConversationSnapshot {
  count: number;
  text: string;
  generating: boolean;
  turnIds: string[];
  latestTurnId: string;
  userCount: number;
  userTurnIds: string[];
  latestUserTurnId: string;
  latestUserText: string;
  assistantAfterLatestUser: boolean;
  interrupted: boolean;
}

export function snapshotOwnsSubmittedUserTurn(
  before: ChatGptConversationSnapshot,
  snapshot: ChatGptConversationSnapshot,
  submittedMessage: string,
  taskId: string,
): boolean {
  const newUserTurn = snapshot.userCount > before.userCount
    || Boolean(snapshot.latestUserTurnId && !before.userTurnIds.includes(snapshot.latestUserTurnId))
    || Boolean(snapshot.latestUserText && snapshot.latestUserText !== before.latestUserText);
  if (!newUserTurn) return false;

  return submittedControlOwnershipMarkers(submittedMessage, taskId)
    .every((marker) => snapshot.latestUserText.includes(marker));
}

export function ownedAssistantResponseCandidate(input: {
  before: ChatGptConversationSnapshot;
  snapshot: ChatGptConversationSnapshot;
  accepted: boolean;
  acceptedOwnedUserTurn: boolean;
}): boolean {
  if (!input.accepted || input.snapshot.interrupted) return false;

  const newAssistantTurn = input.snapshot.latestTurnId
    ? !input.before.turnIds.includes(input.snapshot.latestTurnId)
    : input.snapshot.count > input.before.count;
  const changedAssistantText = input.snapshot.text.trim().length > 0
    && input.snapshot.text !== input.before.text;

  if (input.acceptedOwnedUserTurn) {
    return input.snapshot.assistantAfterLatestUser && (newAssistantTurn || changedAssistantText);
  }

  // When ChatGPT stops exposing user-turn metadata, only accept a strong new
  // assistant identity. Never reuse changed text from the previous assistant.
  return newAssistantTurn;
}

export function assistantActivitySignature(snapshot: ChatGptConversationSnapshot): string {
  return [
    snapshot.count,
    snapshot.latestTurnId,
    snapshot.userCount,
    snapshot.latestUserTurnId,
    snapshot.text.length,
    snapshot.text.slice(-80),
    snapshot.interrupted ? "interrupted" : "ok",
  ].join(":");
}

function submittedControlOwnershipMarkers(message: string, taskId: string): string[] {
  const markers = [`TASK_ID: ${taskId}`];
  for (const name of ["STATE", "ITERATION"] as const) {
    const match = message.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "mi"));
    if (match?.[1]) markers.push(`${name}: ${match[1].trim()}`);
  }
  return markers;
}
