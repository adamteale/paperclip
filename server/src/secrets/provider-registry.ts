import type { SecretProvider, SecretProviderDescriptor } from "@paperclipai/shared";
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import {
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
import type { SecretProviderHealthCheck, SecretProviderModule } from "./types.js";
import { unprocessable } from "../errors.js";
import { withSecretProviderIoTimeout } from "./provider-write-timeout.js";

// TSA-1321: every provider method that performs I/O on behalf of a request is
// raced against the provider write timeout before it is handed out here, so
// no provider — configured, stubbed, or added later — can wedge a secret
// create/rotate (and the per-company mutation lock it runs under) with an
// operation that never settles. Delegation reads each method off the module
// at call time, so test spies on the original module objects keep working.
function withProviderIoTimeouts(provider: SecretProviderModule): SecretProviderModule {
  const bound = <T>(operation: string, run: () => Promise<T>) =>
    withSecretProviderIoTimeout({ provider: provider.id, operation, run });
  const wrapped: SecretProviderModule = {
    ...provider,
    createSecret(input) {
      return bound("createSecret", () => provider.createSecret(input));
    },
    createVersion(input) {
      return bound("createVersion", () => provider.createVersion(input));
    },
    linkExternalSecret(input) {
      return bound("linkExternalSecret", () => provider.linkExternalSecret(input));
    },
    resolveVersion(input) {
      return bound("resolveVersion", () => provider.resolveVersion(input));
    },
    deleteOrArchive(input) {
      return bound("deleteOrArchive", () => provider.deleteOrArchive(input));
    },
  };
  // Optional provider capabilities: only exposed (and only bounded) when the
  // underlying provider actually implements them. Like the core methods
  // above, each reads the method off the module at call time, so test spies
  // installed on the original module objects keep working.
  if (provider.updateExternalSecretValue) {
    wrapped.updateExternalSecretValue = (input) =>
      bound("updateExternalSecretValue", () => provider.updateExternalSecretValue!(input));
  }
  if (provider.listRemoteSecrets) {
    wrapped.listRemoteSecrets = (input) =>
      bound("listRemoteSecrets", () => provider.listRemoteSecrets!(input));
  }
  if (provider.discoverProviderConfigs) {
    wrapped.discoverProviderConfigs = (input) =>
      bound("discoverProviderConfigs", () => provider.discoverProviderConfigs!(input));
  }
  if (provider.rotate) {
    wrapped.rotate = (input) => bound("rotate", () => provider.rotate!(input));
  }
  return wrapped;
}

const providers: SecretProviderModule[] = [
  localEncryptedProvider,
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
].map(withProviderIoTimeouts);

const providerById = new Map<SecretProvider, SecretProviderModule>(
  providers.map((provider) => [provider.id, provider]),
);

export function getSecretProvider(id: SecretProvider): SecretProviderModule {
  const provider = providerById.get(id);
  if (!provider) throw unprocessable(`Unsupported secret provider: ${id}`);
  return provider;
}

export function listSecretProviders(): SecretProviderDescriptor[] {
  return providers.map((provider) => provider.descriptor());
}

export async function checkSecretProviders(): Promise<SecretProviderHealthCheck[]> {
  return Promise.all(providers.map((provider) => provider.healthCheck()));
}
