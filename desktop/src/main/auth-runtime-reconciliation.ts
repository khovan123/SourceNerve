export interface AuthRuntimeReconciliationOptions {
  operation: () => Promise<void>;
  onDeferred: (message: string) => void;
  label: string;
}

/**
 * Runtime reconciliation may start/restart the local daemon. Account bootstrap
 * and a completed Auth0 callback must not be invalidated when that local
 * runtime is degraded. Keep the auth result authoritative and surface the
 * runtime failure separately so it can be repaired from Diagnostics/Connections.
 */
export async function reconcileRuntimeWithoutBlockingAuth(
  options: AuthRuntimeReconciliationOptions,
): Promise<boolean> {
  try {
    await options.operation();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "local runtime reconciliation failed";
    options.onDeferred(`${options.label}: ${message}`);
    return false;
  }
}
