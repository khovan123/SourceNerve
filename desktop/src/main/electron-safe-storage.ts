import { safeStorage } from "electron";

import type { EncryptionBackend } from "./secure-store";

export class ElectronSafeStorageBackend implements EncryptionBackend {
  assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed secure storage is unavailable");
    }
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === "basic_text") {
        throw new Error(
          "Linux secure storage fell back to basic_text; Secret Service/KWallet is required",
        );
      }
    }
  }

  encrypt(value: string): Buffer {
    this.assertAvailable();
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    this.assertAvailable();
    return safeStorage.decryptString(value);
  }

  backendName(): string {
    if (process.platform === "linux") {
      return safeStorage.getSelectedStorageBackend();
    }
    if (process.platform === "darwin") return "keychain";
    if (process.platform === "win32") return "dpapi";
    return "os-crypt";
  }
}
