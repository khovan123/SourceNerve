import path from "node:path";

import { ElectronSafeStorageBackend } from "./electron-safe-storage";
import { ensureInstallationIdentity, type InstallationIdentity } from "./installation";
import {
  EncryptedSecretStore,
  type SecretPresence,
} from "./secure-store";
import {
  loadProductProfile,
  type ProductProfile,
} from "./runtime-profile";

export interface DesktopBootstrapPaths {
  userData: string;
  managedDirectory: string;
  secureDirectory: string;
  stateDirectory: string;
  configPath: string;
  productProfilePath: string;
}

export interface DesktopBootstrapState {
  profile: ProductProfile;
  installation: InstallationIdentity;
  secretStore: EncryptedSecretStore;
  paths: DesktopBootstrapPaths;
  storageBackend: string;
  secretPresence: SecretPresence[];
}

export async function prepareDesktopBootstrap(options: {
  appPath: string;
  userData: string;
  packaged: boolean;
}): Promise<DesktopBootstrapState> {
  const managedDirectory = path.join(options.userData, "managed");
  const secureDirectory = path.join(options.userData, "secure");
  const paths: DesktopBootstrapPaths = {
    userData: options.userData,
    managedDirectory,
    secureDirectory,
    stateDirectory: path.join(options.userData, "state"),
    configPath: path.join(managedDirectory, "sourcenerve.toml"),
    productProfilePath: path.join(
      options.appPath,
      "bootstrap",
      "product-profile.template.json",
    ),
  };

  const profile = await loadProductProfile(paths.productProfilePath, {
    allowPlaceholders: !options.packaged,
  });
  const secretStore = new EncryptedSecretStore(
    secureDirectory,
    new ElectronSafeStorageBackend(),
  );
  const storageBackend = secretStore.storageBackend();
  const installation = await ensureInstallationIdentity(
    managedDirectory,
    secretStore,
  );
  const secretPresence = await secretStore.presence();

  return {
    profile,
    installation,
    secretStore,
    paths,
    storageBackend,
    secretPresence,
  };
}
