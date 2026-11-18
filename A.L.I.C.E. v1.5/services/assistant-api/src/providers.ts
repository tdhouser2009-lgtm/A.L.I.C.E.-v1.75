import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { BlobServiceClient } from "@azure/storage-blob";
import type { AppConfig } from "./config.js";

export interface BlobProvider {
  health(): Promise<void>;
}

export interface ConnectorSecretProvider {
  health(): Promise<void>;
  get(name: string): Promise<string | null>;
}

export interface Providers {
  blob: BlobProvider;
  connectorSecrets: ConnectorSecretProvider;
  health(): Promise<Record<string, "healthy" | "unavailable">>;
}

const CHECKPOINT_CONTAINER = "model-checkpoints";

class AzuriteBlobProvider implements BlobProvider {
  private readonly client: BlobServiceClient;
  private ensured = false;

  constructor(connectionString: string) {
    this.client = BlobServiceClient.fromConnectionString(connectionString, { retryOptions: { maxTries: 1, tryTimeoutInMs: 4_000 } });
  }

  async health(): Promise<void> {
    const container = this.client.getContainerClient(CHECKPOINT_CONTAINER);
    if (!this.ensured) {
      // Local emulator: create the container on first use instead of failing start-up.
      await container.createIfNotExists({ abortSignal: AbortSignal.timeout(3_500) });
      this.ensured = true;
    }
    if (!(await container.exists({ abortSignal: AbortSignal.timeout(3_500) }))) {
      throw new Error("The model-checkpoints Blob container is unavailable.");
    }
  }
}

class ManagedIdentityBlobProvider implements BlobProvider {
  private readonly client: BlobServiceClient;

  constructor(endpoint: string, credential: TokenCredential) {
    this.client = new BlobServiceClient(endpoint, credential, { retryOptions: { maxTries: 1, tryTimeoutInMs: 4_000 } });
  }

  async health(): Promise<void> {
    if (!(await this.client.getContainerClient(CHECKPOINT_CONTAINER).exists({ abortSignal: AbortSignal.timeout(3_500) }))) {
      throw new Error("The model-checkpoints Blob container is unavailable.");
    }
  }
}

class DevelopmentConnectorSecretProvider implements ConnectorSecretProvider {
  async health(): Promise<void> {}
  async get(_name: string): Promise<string | null> {
    return null;
  }
}

class ManagedIdentityConnectorSecretProvider implements ConnectorSecretProvider {
  private readonly client: SecretClient;

  constructor(uri: string, credential: TokenCredential) {
    this.client = new SecretClient(uri, credential);
  }

  async health(): Promise<void> {}

  async get(name: string): Promise<string | null> {
    try {
      return (await this.client.getSecret(name, { abortSignal: AbortSignal.timeout(3_000) })).value ?? null;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
}

export function createProviders(config: AppConfig): Providers {
  const development = config.development;
  const credential = development ? undefined : new DefaultAzureCredential();
  const blob: BlobProvider = development
    ? new AzuriteBlobProvider(config.AZURITE_CONNECTION_STRING!)
    : new ManagedIdentityBlobProvider(config.AZURE_STORAGE_BLOB_ENDPOINT!, credential!);
  const connectorSecrets: ConnectorSecretProvider = development
    ? new DevelopmentConnectorSecretProvider()
    : new ManagedIdentityConnectorSecretProvider(config.KEY_VAULT_URI!, credential!);
  return {
    blob,
    connectorSecrets,
    async health() {
      const entries = await Promise.allSettled([blob.health(), connectorSecrets.health()]);
      return {
        blob: entries[0].status === "fulfilled" ? "healthy" : "unavailable",
        keyVault: entries[1].status === "fulfilled" ? "healthy" : "unavailable",
      };
    },
  };
}
