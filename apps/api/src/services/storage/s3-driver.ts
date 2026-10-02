import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
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

  async putFile(key: string, path: string, contentType: string): Promise<StoredObject> {
    const { size } = await stat(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
    return { key, sizeBytes: size };
  }

  /**
   * Uploads a stream of unknown length, holding at most one part in memory.
   * Short streams become a single PUT; longer ones a multipart upload, which
   * is aborted when the source fails so no partial object is ever visible.
   * A source that throws (for example after its producer exited with an
   * error) therefore never completes an object.
   */
  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType: string,
    options?: { partSizeBytes?: number },
  ): Promise<StoredObject> {
    // S3 parts are at least 5 MiB (except the last) and at most 10,000 per
    // object, so 16 MiB parts allow objects up to about 156 GiB.
    const partSize = Math.max(options?.partSizeBytes ?? 16 * 1024 * 1024, 5 * 1024 * 1024);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let total = 0;
    let uploadId: string | undefined;
    const parts: Array<{ ETag: string | undefined; PartNumber: number }> = [];

    const flushPart = async () => {
      const body = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      if (!uploadId) {
        const created = await this.client.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
          }),
        );
        uploadId = created.UploadId;
        if (!uploadId) throw new Error('S3 did not start a multipart upload');
      }
      const PartNumber = parts.length + 1;
      const result = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber,
          Body: body,
          ContentLength: body.byteLength,
        }),
      );
      parts.push({ ETag: result.ETag, PartNumber });
    };

    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending.push(buffer);
        pendingBytes += buffer.byteLength;
        total += buffer.byteLength;
        if (pendingBytes >= partSize) await flushPart();
      }

      if (!uploadId) {
        const body = Buffer.concat(pending, pendingBytes);
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentLength: body.byteLength,
            ContentType: contentType,
          }),
        );
        return { key, sizeBytes: total };
      }

      if (pendingBytes > 0) await flushPart();
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      return { key, sizeBytes: total };
    } catch (error) {
      if (uploadId) {
        await this.client
          .send(
            new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
          )
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(result.Body instanceof Readable)) throw new Error('Unexpected object body');
      return result.Body;
    } catch {
      throw notFound('Stored file is missing from storage');
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
