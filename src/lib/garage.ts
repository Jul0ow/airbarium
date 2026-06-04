import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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

export type PresignInput = {
  bucket: string;
  key: string;
  expiresInSeconds: number;
};

type Impl = {
  ensureBucket: (bucket: string) => Promise<void>;
  putObject: (input: PutObjectInput) => Promise<void>;
  deleteObject: (input: DeleteObjectInput) => Promise<void>;
  getPresignedUrl: (input: PresignInput) => Promise<string>;
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

  async deleteObject({ bucket, key }) {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  async getPresignedUrl({ bucket, key, expiresInSeconds }) {
    return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  },
};

let impl: Impl = defaultImpl;

export const ensureBucket = (bucket: string) => impl.ensureBucket(bucket);
export const putObject = (input: PutObjectInput) => impl.putObject(input);
export const deleteObject = (input: DeleteObjectInput) => impl.deleteObject(input);
export const getPresignedUrl = (input: PresignInput) => impl.getPresignedUrl(input);

export function __setGarageForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
