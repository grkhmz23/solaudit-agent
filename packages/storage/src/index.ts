import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ── Types ──

export interface StorageProvider {
  putArtifact(
    auditJobId: string,
    key: string,
    body: Buffer | string,
    contentType: string
  ): Promise<{ objectKey: string; sizeBytes: number }>;

  getSignedUrl(objectKey: string, expiresInSecs?: number): Promise<string>;

  deleteArtifact(objectKey: string): Promise<void>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

// ── R2/S3 Implementation ──

export class R2Storage implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucketName;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putArtifact(
    auditJobId: string,
    key: string,
    body: Buffer | string,
    contentType: string
  ): Promise<{ objectKey: string; sizeBytes: number }> {
    const objectKey = `audits/${auditJobId}/${key}`;
    const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: buf,
        ContentType: contentType,
      })
    );

    return { objectKey, sizeBytes: buf.length };
  }

  async getSignedUrl(objectKey: string, expiresInSecs = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSecs });
  }

  async deleteArtifact(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      })
    );
  }
}

// ── Factory ──

let _instance: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (_instance) return _instance;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error(
      "Missing R2 config. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME."
    );
  }

  _instance = new R2Storage({ accountId, accessKeyId, secretAccessKey, bucketName });
  return _instance;
}

export type { S3Client };
