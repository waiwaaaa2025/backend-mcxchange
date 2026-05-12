import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { Request, Response, NextFunction } from 'express';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '../utils/logger';

// S3 client (initialized only if enabled)
let s3Client: S3Client | null = null;
if (config.upload.s3.enabled && config.upload.s3.accessKeyId && config.upload.s3.secretAccessKey) {
  s3Client = new S3Client({
    region: config.upload.s3.region,
    credentials: {
      accessKeyId: config.upload.s3.accessKeyId,
      secretAccessKey: config.upload.s3.secretAccessKey,
    },
  });
  logger.info('S3 storage enabled for file uploads');
}

// Ensure upload directories exist (for local storage fallback)
const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Use memory storage when S3 is enabled, disk storage otherwise
const documentStorage = s3Client
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
        ensureDir(config.upload.uploadDir);
        cb(null, config.upload.uploadDir);
      },
      filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
        const uniqueId = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}${ext}`);
      },
    });

// Configure storage for avatars (always local for now)
const avatarStorage = multer.diskStorage({
  destination: (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    const avatarDir = path.join(config.upload.uploadDir, 'avatars');
    ensureDir(avatarDir);
    cb(null, avatarDir);
  },
  filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const uniqueId = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  },
});

// Legacy storage (for backward compatibility)
const storage = documentStorage;

// File filter
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void => {
  const allowedTypes: string[] = config.upload.allowedTypes;
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`));
  }
};

// Create multer instance
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxFileSize,
  },
});

// Upload file to S3
async function uploadToS3(file: Express.Multer.File): Promise<string> {
  if (!s3Client) throw new Error('S3 is not configured');

  const uniqueId = uuidv4();
  const ext = path.extname(file.originalname);
  const key = `documents/${uniqueId}${ext}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: config.upload.s3.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));

  return `https://${config.upload.s3.bucket}.s3.${config.upload.s3.region}.amazonaws.com/${key}`;
}

// Single file upload middleware — handles S3 upload if enabled
const multerSingle = upload.single('file');

export const uploadSingle = (req: Request, res: Response, next: NextFunction) => {
  multerSingle(req, res, async (err: any) => {
    if (err) {
      logger.error('Multer upload error:', err?.message || err, 'code:', err?.code, 'name:', err?.name);
      return next(err);
    }

    if (!req.file) {
      // No file in request — let the controller handle the missing file
      return next();
    }

    // If S3 is enabled and we have a file buffer, upload to S3
    if (s3Client && req.file.buffer) {
      try {
        const url = await uploadToS3(req.file);
        (req.file as any).s3Url = url;
      } catch (s3Err: any) {
        logger.error('S3 upload failed:', s3Err?.message || s3Err, 'bucket:', config.upload.s3.bucket, 'region:', config.upload.s3.region);
        return next(new Error(`Failed to upload file to storage: ${s3Err?.message || 'Unknown error'}`));
      }
    } else if (s3Client && !req.file.buffer) {
      logger.warn('S3 enabled but file has no buffer — file may have been saved to disk instead');
    }

    next();
  });
};

// Multiple files upload (max 10)
export const uploadMultiple = upload.array('files', 10);

// Fields upload for specific document types
export const uploadDocuments = upload.fields([
  { name: 'insurance', maxCount: 1 },
  { name: 'uccFiling', maxCount: 1 },
  { name: 'authority', maxCount: 1 },
  { name: 'safetyRecord', maxCount: 1 },
  { name: 'other', maxCount: 5 },
]);

// Image filter for avatars
const imageFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed for avatars'));
  }
};

// Avatar upload multer instance
const avatarMulter = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max for avatars
  },
});

// Avatar upload middleware
export const avatarUpload = avatarMulter.single('avatar');

// Truck photo upload — images only, up to 5 per request, uploads to S3 if enabled
const truckPhotoMulter = multer({
  storage: s3Client ? multer.memoryStorage() : documentStorage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per image
  },
});

const multerTruckPhotos = truckPhotoMulter.array('photos', 5);

async function uploadTruckPhotoToS3(file: Express.Multer.File): Promise<string> {
  if (!s3Client) throw new Error('S3 is not configured');
  const uniqueId = uuidv4();
  const ext = path.extname(file.originalname);
  const key = `trucks/${uniqueId}${ext}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.upload.s3.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );
  return `https://${config.upload.s3.bucket}.s3.${config.upload.s3.region}.amazonaws.com/${key}`;
}

export const uploadTruckPhotos = (req: Request, res: Response, next: NextFunction) => {
  multerTruckPhotos(req, res, async (err: any) => {
    if (err) {
      logger.error('Truck photo upload error:', err?.message || err);
      return next(err);
    }
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (s3Client && files.length > 0) {
      try {
        for (const f of files) {
          if (f.buffer) {
            (f as any).s3Url = await uploadTruckPhotoToS3(f);
          }
        }
      } catch (s3Err: any) {
        logger.error('S3 truck photo upload failed:', s3Err?.message || s3Err);
        return next(new Error(`Failed to upload truck photos: ${s3Err?.message || 'Unknown error'}`));
      }
    }
    next();
  });
};

/**
 * Generate a pre-signed URL for an S3 object.
 * Extracts the S3 key from a full S3 URL or uses the string as-is if it's already a key.
 * Returns null if S3 is not configured or the URL is not an S3 URL.
 */
export async function getPresignedUrl(
  url: string,
  expiresIn: number = 3600,
  responseContentDisposition?: string
): Promise<string | null> {
  if (!s3Client) return null;

  const bucket = config.upload.s3.bucket;
  const region = config.upload.s3.region;

  // Extract key from full S3 URL
  let key: string;
  const s3UrlPrefix = `https://${bucket}.s3.${region}.amazonaws.com/`;
  if (url.startsWith(s3UrlPrefix)) {
    key = decodeURIComponent(url.slice(s3UrlPrefix.length));
  } else if (url.startsWith('https://') || url.startsWith('http://')) {
    // Not an S3 URL we recognize
    return null;
  } else {
    // Assume it's already a key
    key = url;
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(responseContentDisposition
      ? { ResponseContentDisposition: responseContentDisposition }
      : {}),
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

export default upload;
