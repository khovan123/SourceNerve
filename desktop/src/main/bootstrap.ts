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
import { resolveStateDirectoryFromManagedDirectory } from "./state-location";

export interface DesktopBootstrapPaths {
  userData: string;
  managedDirectory: string;
  secureDirectory: string;
  stateDirectory: string;
  configPath: string;
  workspaceRegistryPath: string;
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
  const defaultStateDirectory = path.join(options.userData, "state");
  const paths: DesktopBootstrapPaths = {
    userData: options.userData,
    managedDirectory,
    secureDirectory,
    stateDirectory: await resolveStateDirectoryFromManagedDirectory(
      managedDirectory,
      defaultStateDirectory,
    ),
    configPath: path.join(managedDirectory, "sourcenerve.toml"),
    workspaceRegistryPath: path.join(managedDirectory, "workspaces.json"),
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
