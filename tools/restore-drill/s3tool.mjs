// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone container script, never a Turbo task.
/**
 * A small S3 helper for the restore drill, run inside the API image (compose
 * service `tool`, mounted at /app/apps/api/s3tool.mjs) so that it uses the
 * image's AWS SDK and nothing has to be installed on the host. It prints one
 * JSON value (or text) on stdout. Credentials come from the environment
 * (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: throwaway test values).
 *
 *   ping
 *   mkbucket <bucket>
 *   list <bucket> [prefix]        [{ key, size }] for every object
 *   wipe <bucket>                 deletes every object (the bucket stays)
 *   get <bucket> <key>            the object's text
 *   sha256 <bucket> <key>         the hex SHA-256 of the object's bytes
 *   runs <bucket> <prefix>        every backup run's folder and manifest summary
 */
import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

async function list(Bucket, Prefix = '') {
  const objects = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const object of page.Contents ?? [])
      objects.push({ key: object.Key, size: object.Size ?? 0 });
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

async function bytes(Bucket, Key) {
  const response = await s3.send(new GetObjectCommand({ Bucket, Key }));
  return Buffer.from(await response.Body.transformToByteArray());
}

const [command, bucket, arg] = process.argv.slice(2);
if (command === 'ping') {
  await s3.send(new ListBucketsCommand({}));
  console.log('ok');
} else if (command === 'mkbucket') {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(error?.name ?? error)))
      throw error;
  }
  console.log('ok');
} else if (command === 'list') {
  console.log(JSON.stringify(await list(bucket, arg ?? '')));
} else if (command === 'wipe') {
  const objects = await list(bucket);
  for (let i = 0; i < objects.length; i += 500) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.slice(i, i + 500).map((o) => ({ Key: o.key })), Quiet: true },
      }),
    );
  }
  console.log(JSON.stringify({ deleted: objects.length }));
} else if (command === 'get') {
  process.stdout.write((await bytes(bucket, arg)).toString('utf8'));
} else if (command === 'sha256') {
  console.log(
    createHash('sha256')
      .update(await bytes(bucket, arg))
      .digest('hex'),
  );
} else if (command === 'runs') {
  const runs = [];
  for (const { key } of await list(bucket, arg)) {
    if (!key.endsWith('/manifest.json')) continue;
    const manifest = JSON.parse((await bytes(bucket, key)).toString('utf8'));
    runs.push({
      folder: key.slice(0, -'manifest.json'.length),
      createdAt: manifest.createdAt,
      format: manifest.format,
      database: manifest.database ?? null,
      filesCopied: manifest.files?.copied ?? false,
      attachments: manifest.attachments?.objects ?? null,
    });
  }
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  console.log(JSON.stringify(runs));
} else {
  console.error(`Unknown command: ${command ?? ''}`);
  process.exit(2);
}
