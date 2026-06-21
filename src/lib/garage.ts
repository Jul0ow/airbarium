import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SPECIMENS_BUCKET } from '@/config/constants';
import { env } from '@/config/env';
import { logger } from '@/middleware/logger';

export type PutObjectInput = {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
};

export type DeleteObjectInput = {
  bucket: string;
  key: string;
};

export type DeleteObjectsInput = {
  bucket: string;
  keys: string[];
};

export type DeleteObjectsResult = {
  deleted: string[];
  errors: Array<{ key: string; message?: string }>;
};

// S3 DeleteObjects accepts at most 1000 keys per request.
const DELETE_OBJECTS_BATCH = 1000;

export type GetObjectInput = {
  bucket: string;
  key: string;
};

export type PresignInput = {
  bucket: string;
  key: string;
  expiresInSeconds: number;
};

export type GarageObject = { key: string; lastModified: Date };

export type ListObjectsInput = {
  bucket: string;
  prefix?: string;
};

type Impl = {
  ensureBucket: (bucket: string) => Promise<void>;
  putObject: (input: PutObjectInput) => Promise<void>;
  getObject: (input: GetObjectInput) => Promise<Uint8Array>;
  deleteObject: (input: DeleteObjectInput) => Promise<void>;
  deleteObjects: (input: DeleteObjectsInput) => Promise<DeleteObjectsResult>;
  getPresignedUrl: (input: PresignInput) => Promise<string>;
  listObjects: (input: ListObjectsInput) => Promise<GarageObject[]>;
  pingGarage: () => Promise<void>;
};

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.GARAGE_ENDPOINT,
      region: env.GARAGE_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.GARAGE_ACCESS_KEY,
        secretAccessKey: env.GARAGE_SECRET_KEY,
      },
    });
  }
  return client;
}

const defaultImpl: Impl = {
  async ensureBucket(bucket) {
    const s3 = getClient();
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      const isMissing = status === 404 || name === 'NotFound' || name === 'NoSuchBucket';
      if (!isMissing) {
        logger.warn({ err, bucket }, 'garage.ensureBucket: head failed');
        throw err;
      }
    }
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    logger.info({ bucket }, 'garage.bucket.created');
  },

  async putObject({ bucket, key, body, contentType }) {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  },

  async getObject({ bucket, key }) {
    const out = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) {
      // Object exists in metadata but has no body — treat as missing.
      const err = new Error(`garage.getObject: empty body for ${bucket}/${key}`);
      err.name = 'NoSuchKey';
      throw err;
    }
    return out.Body.transformToByteArray();
  },

  async deleteObject({ bucket, key }) {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  // Batch delete (up to 1000 keys/request) for bulk purges (cron + RGPD account
  // deletion). Never throws: a failed chunk maps every key in it to `errors`, so
  // callers get a per-key outcome and a Garage outage can't abort the purge.
  async deleteObjects({ bucket, keys }) {
    const result: DeleteObjectsResult = { deleted: [], errors: [] };
    if (keys.length === 0) return result;
    const s3 = getClient();
    for (let i = 0; i < keys.length; i += DELETE_OBJECTS_BATCH) {
      const chunk = keys.slice(i, i + DELETE_OBJECTS_BATCH);
      try {
        const out = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
          }),
        );
        for (const d of out.Deleted ?? []) if (d.Key) result.deleted.push(d.Key);
        for (const e of out.Errors ?? []) {
          if (e.Key) {
            result.errors.push(
              e.Message === undefined ? { key: e.Key } : { key: e.Key, message: e.Message },
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const key of chunk) result.errors.push({ key, message });
      }
    }
    return result;
  },

  async getPresignedUrl({ bucket, key, expiresInSeconds }) {
    return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  },

  // Readiness probe: a cheap HeadBucket round-trip proving Garage is reachable
  // and credentials are valid. Throws on any failure (caller maps to 503).
  async pingGarage() {
    await getClient().send(new HeadBucketCommand({ Bucket: SPECIMENS_BUCKET }));
  },

  async listObjects({ bucket, prefix }) {
    const s3 = getClient();
    const objects: GarageObject[] = [];
    let continuationToken: string | undefined;
    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of out.Contents ?? []) {
        if (obj.Key) {
          // LastModified is optional in the SDK type but Garage always sets it. The epoch
          // fallback makes a value-less object look "very old" — fine since the orphan
          // reconciler only deletes UNREFERENCED objects, never referenced ones.
          objects.push({ key: obj.Key, lastModified: obj.LastModified ?? new Date(0) });
        }
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  },
};

let impl: Impl = defaultImpl;

export const ensureBucket = (bucket: string) => impl.ensureBucket(bucket);
export const putObject = (input: PutObjectInput) => impl.putObject(input);
export const getObject = (input: GetObjectInput) => impl.getObject(input);
export const deleteObject = (input: DeleteObjectInput) => impl.deleteObject(input);
export const deleteObjects = (input: DeleteObjectsInput) => impl.deleteObjects(input);
export const getPresignedUrl = (input: PresignInput) => impl.getPresignedUrl(input);
export const listObjects = (input: ListObjectsInput) => impl.listObjects(input);
export const pingGarage = () => impl.pingGarage();

export function __setGarageForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
