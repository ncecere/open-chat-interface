import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { notFound } from '../../lib/errors.js';
import type { ListPage, StorageDriver, StoredObject } from './driver.js';

export interface S3DriverConfig {
  bucket: string;
  region: string;
  endpoint?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted gateways require path-style addressing. */
  forcePathStyle?: boolean;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3DriverConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /** Checks bucket access without listing or returning object metadata. */
  async checkReadAccess(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /**
   * Verifies `s3:ListBucket`, which reconciliation needs and which a
   * write-only credential will not have. Checked separately so the admin
   * storage test can say precisely which permission is missing.
   */
  async checkListAccess(): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new Error('Empty object body');
      return Buffer.from(bytes);
    } catch {
      throw notFound('Attachment file is missing from storage');
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async list(options?: { cursor?: string; limit?: number }): Promise<ListPage> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        MaxKeys: Math.max(1, Math.min(options?.limit ?? 1_000, 1_000)),
        ...(options?.cursor ? { ContinuationToken: options.cursor } : {}),
      }),
    );

    const objects = (result.Contents ?? []).flatMap((entry) =>
      entry.Key
        ? [
            {
              key: entry.Key,
              sizeBytes: entry.Size ?? 0,
              lastModified: entry.LastModified ?? new Date(0),
            },
          ]
        : [],
    );

    return {
      objects,
      ...(result.IsTruncated && result.NextContinuationToken
        ? { cursor: result.NextContinuationToken }
        : {}),
    };
  }
}
