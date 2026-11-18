import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

/** Mirrors checkpoints to Blob storage (Azurite locally) as model-checkpoints/{id}.pt. Best effort. */
export class BlobMirror {
  private readonly container: ContainerClient;

  constructor(connectionString: string) {
    const client = BlobServiceClient.fromConnectionString(connectionString, { retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 } });
    this.container = client.getContainerClient("model-checkpoints");
  }

  async ensureContainer(): Promise<void> {
    await this.container.createIfNotExists();
  }

  async upload(checkpointId: string, file: string): Promise<void> {
    await this.container.getBlockBlobClient(`${checkpointId}.pt`).uploadFile(file);
  }
}
