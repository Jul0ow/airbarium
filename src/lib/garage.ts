import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
  getPresignedUrl: (input: PresignInput) => Promise<string>;
  listObjects: (input: ListObjectsInput) => Promise<GarageObject[]>;
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

  async getPresignedUrl({ bucket, key, expiresInSeconds }) {
    return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
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
export const getPresignedUrl = (input: PresignInput) => impl.getPresignedUrl(input);
export const listObjects = (input: ListObjectsInput) => impl.listObjects(input);

export function __setGarageForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
