/**
 * File handling for Slack file uploads.
 * Downloads files to memory, optionally resizes images, and prepares them for agent input.
 */

import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

const DEFAULT_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB per file
const DEFAULT_MAX_FILE_COUNT = 20; // 20 files per message
const DOWNLOAD_TIMEOUT_MS = 30000; // 30 seconds
const DEFAULT_MAX_IMAGE_INLINE_BYTES = 3.75 * 1024 * 1024; // ~3.75MB inline cap
const IMAGE_RESIZE_STEPS = [
  { maxDimension: 2048, quality: 85 },
  { maxDimension: 1024, quality: 80 },
];

export interface ResizeResult {
  buffer: Buffer;
  mimetype: string;
  resized: boolean;
  tooLarge: boolean;
}

export interface SlackFile {
  id: string;
  name: string | null;
  mimetype?: string;
  filetype?: string;
  size?: number;
  created?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface ProcessedFile {
  index: number;
  name: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  base64?: string;
  localPath?: string;
  isImage: boolean;
  isText: boolean;
  error?: string;
}

export interface ProcessFilesResult {
  files: ProcessedFile[];
  warnings: string[];
}

export type InlineImageMode = 'always' | 'if-small' | 'never';

export interface ProcessSlackFilesOptions {
  downloadFile?: (file: SlackFile, token: string) => Promise<Buffer>;
  writeTempFile?: (buffer: Buffer, filename: string, extension: string) => Promise<string>;
  resizeImageIfNeeded?: (buffer: Buffer, mimetype: string, maxInlineBytes: number) => Promise<ResizeResult>;
  maxFileSizeBytes?: number;
  maxFileCount?: number;
  maxImageInlineBytes?: number;
  inlineImages?: InlineImageMode;
}

export function isImageFile(mimetype: string): boolean {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimetype);
}

export function isTextFile(mimetype: string): boolean {
  if (mimetype.startsWith('text/')) return true;
  const textMimetypes = [
    'application/json',
    'application/javascript',
    'application/typescript',
    'application/xml',
    'application/x-yaml',
    'application/x-sh',
    'application/x-python',
  ];
  return textMimetypes.includes(mimetype);
}

export function isTextFileByExtension(filename: string): boolean {
  const textExtensions = [
    'txt', 'md', 'markdown',
    'json', 'yaml', 'yml',
    'js', 'ts', 'jsx', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'xml', 'svg',
    'sh', 'bash', 'zsh',
    'toml', 'ini', 'cfg', 'conf', 'config', 'env',
    'sql', 'graphql', 'gql',
    'csv', 'log',
    'gitignore', 'dockerignore',
  ];
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? textExtensions.includes(ext) : false;
}

export function isBinaryFile(mimetype: string): boolean {
  const binaryPrefixes = ['audio/', 'video/'];
  const binaryMimetypes = [
    'application/pdf',
    'application/zip',
    'application/x-tar',
    'application/x-gzip',
    'application/octet-stream',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ];
  return binaryPrefixes.some(p => mimetype.startsWith(p)) || binaryMimetypes.includes(mimetype);
}

function getExtension(mimetype: string, filetype?: string): string {
  if (filetype) return filetype;

  const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/json': 'json',
    'application/javascript': 'js',
    'application/typescript': 'ts',
    'application/xml': 'xml',
    'application/x-yaml': 'yaml',
  };
  return mimeToExt[mimetype] || 'bin';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getFallbackName(file: SlackFile): string {
  const ext = getExtension(file.mimetype || 'application/octet-stream', file.filetype);
  return `${file.id}-unnamed.${ext}`;
}

export async function downloadSlackFile(file: SlackFile, token: string): Promise<Buffer> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    throw new Error('No download URL available');
  }

  return await new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total > DEFAULT_MAX_FILE_SIZE) {
          req.destroy(new Error('File too large'));
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('Download timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function writeTempFile(buffer: Buffer, filename: string, extension: string): Promise<string> {
  const safeName = sanitizeFilename(filename || 'file');
  const unique = randomUUID();
  const tempName = `caia-${Date.now()}-${unique}-${safeName}.${extension}`;
  const tempPath = path.join(os.tmpdir(), tempName);
  await fs.promises.writeFile(tempPath, buffer);
  return tempPath;
}

export async function resizeImageIfNeeded(
  buffer: Buffer,
  mimetype: string,
  maxInlineBytes: number = DEFAULT_MAX_IMAGE_INLINE_BYTES
): Promise<ResizeResult> {
  if (buffer.length <= maxInlineBytes) {
    return { buffer, mimetype, resized: false, tooLarge: false };
  }

  let smallest: Buffer | null = null;
  for (const step of IMAGE_RESIZE_STEPS) {
    const resized = await sharp(buffer, { failOnError: false })
      .rotate()
      .resize(step.maxDimension, step.maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: step.quality, mozjpeg: true })
      .toBuffer();

    if (!smallest || resized.length < smallest.length) {
      smallest = resized;
    }

    if (resized.length <= maxInlineBytes) {
      return {
        buffer: resized,
        mimetype: 'image/jpeg',
        resized: true,
        tooLarge: false,
      };
    }
  }

  if (smallest) {
    return {
      buffer: smallest,
      mimetype: 'image/jpeg',
      resized: true,
      tooLarge: smallest.length > maxInlineBytes,
    };
  }

  return { buffer, mimetype, resized: false, tooLarge: true };
}

export async function processSlackFiles(
  files: SlackFile[],
  token: string,
  options: ProcessSlackFilesOptions = {}
): Promise<ProcessFilesResult> {
  const warnings: string[] = [];
  const processedFiles: ProcessedFile[] = [];

  const maxFileSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const maxFileCount = options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT;
  const maxInlineBytes = options.maxImageInlineBytes ?? DEFAULT_MAX_IMAGE_INLINE_BYTES;
  const inlineMode: InlineImageMode = options.inlineImages ?? 'if-small';

  let filesToProcess = files;
  if (files.length > maxFileCount) {
    warnings.push(`${files.length - maxFileCount} additional files skipped (max ${maxFileCount})`);
    filesToProcess = files.slice(0, maxFileCount);
  }

  const sortedFiles = filesToProcess
    .map((file, originalIndex) => ({ file, originalIndex }))
    .sort((a, b) => {
      const createdA = a.file.created ?? 0;
      const createdB = b.file.created ?? 0;
      if (createdA !== createdB) return createdA - createdB;
      return a.originalIndex - b.originalIndex;
    });

  const download = options.downloadFile ?? downloadSlackFile;
  const writeTemp = options.writeTempFile;
  const resizeImage = options.resizeImageIfNeeded ?? resizeImageIfNeeded;

  for (let i = 0; i < sortedFiles.length; i++) {
    const { file } = sortedFiles[i];
    const index = i + 1;
    const name = file.name || getFallbackName(file);
    const mimetype = file.mimetype || 'application/octet-stream';
    const extension = getExtension(mimetype, file.filetype);
    const isImage = isImageFile(mimetype);
    const isText = isTextFile(mimetype) || isTextFileByExtension(name);
    const isBinary = isBinaryFile(mimetype) && !isText;

    if (isBinary) {
      const typeLabel = mimetype.startsWith('audio/') ? 'audio' :
        mimetype.startsWith('video/') ? 'video' :
        mimetype === 'application/pdf' ? 'PDF' : 'binary';
      warnings.push(`File ${index} (${name}) skipped - ${typeLabel} files not supported`);
      continue;
    }

    if (file.size && file.size > maxFileSize) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      warnings.push(`File ${index} (${name}) too large (${sizeMB}MB, max ${(maxFileSize / 1024 / 1024).toFixed(0)}MB)`);
      continue;
    }

    try {
      let buffer = await download(file, token);
      let outputMimetype = mimetype;
      let outputExtension = extension;
      let base64: string | undefined;
      let localPath: string | undefined;

      if (isImage) {
        try {
          const resizeResult = await resizeImage(buffer, mimetype, maxInlineBytes);
          buffer = resizeResult.buffer;
          outputMimetype = resizeResult.mimetype;
          outputExtension = getExtension(outputMimetype);

          if (resizeResult.resized && resizeResult.tooLarge) {
            const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
            warnings.push(`File ${index} (${name}) image still too large for inline data URL after resize (${sizeMB}MB, max ${(maxInlineBytes / 1024 / 1024).toFixed(2)}MB)`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          warnings.push(`File ${index} (${name}) image resize failed: ${errorMsg}`);
        }

        if (writeTemp) {
          localPath = await writeTemp(buffer, name, outputExtension);
        }

        if (inlineMode === 'always') {
          if (buffer.length <= maxInlineBytes) {
            base64 = buffer.toString('base64');
          } else {
            const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
            warnings.push(`File ${index} (${name}) image too large for inline data URL (${sizeMB}MB, max ${(maxInlineBytes / 1024 / 1024).toFixed(2)}MB)`);
          }
        } else if (inlineMode === 'if-small') {
          if (buffer.length <= maxInlineBytes) {
            base64 = buffer.toString('base64');
          }
        }
      }

      processedFiles.push({
        index,
        name,
        mimetype: outputMimetype,
        size: buffer.length,
        buffer,
        base64,
        localPath,
        isImage,
        isText,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.toLowerCase().includes('timed out')) {
        warnings.push(`File ${index} (${name}) download timed out`);
      } else {
        warnings.push(`File ${index} (${name}) could not be downloaded: ${errorMsg}`);
      }
      processedFiles.push({
        index,
        name,
        mimetype,
        size: 0,
        buffer: Buffer.alloc(0),
        isImage,
        isText,
        error: errorMsg,
      });
    }
  }

  return { files: processedFiles, warnings };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
