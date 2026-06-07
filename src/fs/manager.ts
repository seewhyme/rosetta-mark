import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ParagraphMapping, TranslationMetadata } from '../types';

export interface FileMetadata {
  [sourcePath: string]: string;
}

export interface ExtendedMetadata {
  hashes: FileMetadata;
  translations: { [translationPath: string]: TranslationMetadata };
}

export interface CacheCleanupOptions {
  retentionDays: number;
  maxSizeMB: number;
  now?: number;
  protectedPaths?: string[];
}

export interface CacheCleanupResult {
  deletedFiles: number;
  deletedBytes: number;
  remainingBytes: number;
}

interface CacheEntry {
  relativeTranslationPath: string;
  translationPath: string;
  metadata: TranslationMetadata;
  sizeBytes: number;
  lastAccessedAt: number;
}

export class FileSystemManager {
  private workspaceRoot: string;
  private translationDir: string;
  private metadataPath: string;
  private legacyTranslationDir: string;
  private migrationMarkerPath: string;
  private metadataWriteChain: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, storageRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.translationDir = path.join(
      storageRoot,
      'translation-cache',
      this.getWorkspaceHash(),
      '.rosetta-mark'
    );
    this.metadataPath = path.join(this.translationDir, 'metadata.json');
    this.legacyTranslationDir = path.join(workspaceRoot, '.rosetta-mark');
    this.migrationMarkerPath = path.join(this.translationDir, '.migration-complete');
  }

  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  private calculateHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private getWorkspaceHash(): string {
    return crypto.createHash('sha256').update(path.resolve(this.workspaceRoot)).digest('hex');
  }

  private getCacheKey(sourcePath: string, configSignature: string): string {
    const relativePath = path.relative(this.workspaceRoot, sourcePath);
    return `${configSignature}:${relativePath}`;
  }

  private isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = path.relative(parentPath, childPath);
    return (
      relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
    );
  }

  private async readMetadata(): Promise<FileMetadata> {
    try {
      const data = await fs.readFile(this.metadataPath, 'utf-8');
      const parsed = JSON.parse(data);
      // 兼容旧格式和新格式
      if (parsed.hashes) {
        return parsed.hashes;
      }
      return parsed;
    } catch {
      return {};
    }
  }

  private async readExtendedMetadata(): Promise<ExtendedMetadata> {
    try {
      const data = await fs.readFile(this.metadataPath, 'utf-8');
      const parsed = JSON.parse(data);
      // 兼容旧格式
      if (!parsed.hashes) {
        return { hashes: parsed, translations: {} };
      }
      return {
        hashes: parsed.hashes ?? {},
        translations: parsed.translations ?? {},
      };
    } catch {
      return { hashes: {}, translations: {} };
    }
  }

  private async writeMetadata(metadata: FileMetadata): Promise<void> {
    await this.ensureDir(this.translationDir);
    const extended = await this.readExtendedMetadata();
    extended.hashes = metadata;
    await fs.writeFile(this.metadataPath, JSON.stringify(extended, null, 2), 'utf-8');
  }

  private async writeExtendedMetadata(metadata: ExtendedMetadata): Promise<void> {
    await this.ensureDir(this.translationDir);
    await fs.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  private async queueMetadataWrite(fn: () => Promise<void>): Promise<void> {
    const prev = this.metadataWriteChain;
    let resolve: () => void;
    let reject: (err: unknown) => void;
    this.metadataWriteChain = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    await prev;
    try {
      await fn();
      resolve!();
    } catch (err) {
      reject!(err);
      throw err;
    }
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  private async getFileTimestamp(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.mtimeMs;
    } catch {
      return Date.now();
    }
  }

  private async removeEmptyDirectories(startDir: string): Promise<void> {
    let currentDir = startDir;

    while (
      this.isPathInside(this.translationDir, currentDir) &&
      currentDir !== this.translationDir
    ) {
      try {
        await fs.rmdir(currentDir);
      } catch {
        break;
      }
      currentDir = path.dirname(currentDir);
    }
  }

  private async getCacheEntries(metadata: ExtendedMetadata): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    const indexedPaths = new Set(Object.keys(metadata.translations));

    for (const [relativeTranslationPath, translationMetadata] of Object.entries(
      metadata.translations
    )) {
      const translationPath = path.join(this.translationDir, relativeTranslationPath);
      const sizeBytes = translationMetadata.sizeBytes ?? (await this.getFileSize(translationPath));
      const lastAccessedAt =
        translationMetadata.lastAccessedAt ??
        translationMetadata.savedAt ??
        (await this.getFileTimestamp(translationPath));

      entries.push({
        relativeTranslationPath,
        translationPath,
        metadata: translationMetadata,
        sizeBytes,
        lastAccessedAt,
      });
    }

    for (const filePath of await this.listTranslationFiles(this.translationDir)) {
      const relativeTranslationPath = path.relative(this.translationDir, filePath);
      if (indexedPaths.has(relativeTranslationPath)) {
        continue;
      }

      const [configSignature, ...sourceParts] = relativeTranslationPath.split(path.sep);
      if (!configSignature || sourceParts.length === 0) {
        continue;
      }

      const sourcePath = sourceParts.join(path.sep);
      const fileTimestamp = await this.getFileTimestamp(filePath);
      entries.push({
        relativeTranslationPath,
        translationPath: filePath,
        metadata: {
          sourceHash: metadata.hashes[`${configSignature}:${sourcePath}`] ?? '',
          sourcePath,
          configSignature,
          paragraphs: [],
        },
        sizeBytes: await this.getFileSize(filePath),
        lastAccessedAt: fileTimestamp,
      });
    }

    return entries;
  }

  private async listTranslationFiles(dirPath: string): Promise<string[]> {
    let dirEntries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;

    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];

    for (const dirEntry of dirEntries) {
      const entryPath = path.join(dirPath, dirEntry.name);

      if (dirEntry.isDirectory()) {
        files.push(...(await this.listTranslationFiles(entryPath)));
        continue;
      }

      if (
        dirEntry.isFile() &&
        entryPath !== this.metadataPath &&
        entryPath !== this.migrationMarkerPath
      ) {
        files.push(entryPath);
      }
    }

    return files;
  }

  private async deleteEntry(
    metadata: ExtendedMetadata,
    entry: CacheEntry
  ): Promise<CacheCleanupResult> {
    let deletedBytes = 0;

    try {
      const stat = await fs.stat(entry.translationPath);
      deletedBytes = stat.size;
      await fs.rm(entry.translationPath, { force: true });
      await this.removeEmptyDirectories(path.dirname(entry.translationPath));
    } catch {
      deletedBytes = entry.sizeBytes;
    }

    delete metadata.translations[entry.relativeTranslationPath];

    const cacheKey = this.getCacheKey(
      path.join(this.workspaceRoot, entry.metadata.sourcePath),
      entry.metadata.configSignature ??
        entry.relativeTranslationPath.split(path.sep)[0] ??
        'default'
    );
    delete metadata.hashes[cacheKey];
    delete metadata.hashes[entry.metadata.sourcePath];

    return {
      deletedFiles: 1,
      deletedBytes,
      remainingBytes: 0,
    };
  }

  private async markTranslationAccessed(translationPath: string): Promise<void> {
    return this.queueMetadataWrite(async () => {
      const extended = await this.readExtendedMetadata();
      const relativeTranslationPath = path.relative(this.translationDir, translationPath);
      const metadata = extended.translations[relativeTranslationPath];

      if (!metadata) {
        return;
      }

      metadata.lastAccessedAt = Date.now();
      metadata.sizeBytes = await this.getFileSize(translationPath);
      await this.writeExtendedMetadata(extended);
    });
  }

  getTranslationPath(sourcePath: string, configSignature: string = 'default'): string {
    const relativePath = path.relative(this.workspaceRoot, sourcePath);
    return path.join(this.translationDir, configSignature, relativePath);
  }

  /**
   * 从翻译文件路径获取原文件路径
   */
  getSourcePathFromTranslation(translationPath: string): string | null {
    const relativePath = path.relative(this.translationDir, translationPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null; // 不是翻译文件
    }

    const [, ...sourceParts] = relativePath.split(path.sep);
    if (sourceParts.length === 0) {
      return null;
    }

    return path.join(this.workspaceRoot, ...sourceParts);
  }

  /**
   * 判断给定路径是否为翻译文件
   */
  isTranslationFile(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    const normalizedTranslationDir = path.normalize(this.translationDir);
    const normalizedLegacyTranslationDir = path.normalize(this.legacyTranslationDir);
    return (
      normalizedPath.startsWith(normalizedTranslationDir + path.sep) ||
      normalizedPath.startsWith(normalizedLegacyTranslationDir + path.sep)
    );
  }

  /**
   * 获取翻译目录路径
   */
  getTranslationDir(): string {
    return this.translationDir;
  }

  async migrateLegacyCacheIfNeeded(): Promise<boolean> {
    if (path.normalize(this.legacyTranslationDir) === path.normalize(this.translationDir)) {
      return false;
    }

    const [legacyExists, migrationMarkerExists, newEntries] = await Promise.all([
      fs
        .access(this.legacyTranslationDir)
        .then(() => true)
        .catch(() => false),
      fs
        .access(this.migrationMarkerPath)
        .then(() => true)
        .catch(() => false),
      fs.readdir(this.translationDir).catch(() => []),
    ]);

    if (!legacyExists || migrationMarkerExists || newEntries.length > 0) {
      return false;
    }

    await this.ensureDir(path.dirname(this.translationDir));
    await fs.cp(this.legacyTranslationDir, this.translationDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await fs.writeFile(this.migrationMarkerPath, '', 'utf-8');
    return true;
  }

  async needsTranslation(
    sourcePath: string,
    content: string,
    configSignature: string = 'default'
  ): Promise<boolean> {
    const hash = this.calculateHash(content);
    const metadata = await this.readMetadata();
    const cacheKey = this.getCacheKey(sourcePath, configSignature);

    const translationPath = this.getTranslationPath(sourcePath, configSignature);
    const translationExists = await fs
      .access(translationPath)
      .then(() => true)
      .catch(() => false);

    if (!translationExists) {
      return true;
    }

    const isCurrent = metadata[cacheKey] === hash;
    if (isCurrent) {
      await this.markTranslationAccessed(translationPath);
    }

    return !isCurrent;
  }

  async saveTranslation(
    sourcePath: string,
    content: string,
    translatedContent: string,
    configSignature: string = 'default'
  ): Promise<string> {
    const translationPath = this.getTranslationPath(sourcePath, configSignature);
    const translationDir = path.dirname(translationPath);

    await this.ensureDir(translationDir);
    await fs.writeFile(translationPath, translatedContent, 'utf-8');

    const now = Date.now();
    const hash = this.calculateHash(content);

    await this.queueMetadataWrite(async () => {
      const extended = await this.readExtendedMetadata();
      const relativePath = path.relative(this.workspaceRoot, sourcePath);
      const cacheKey = this.getCacheKey(sourcePath, configSignature);
      const relativeTranslationPath = path.relative(this.translationDir, translationPath);

      extended.hashes[cacheKey] = hash;
      extended.translations[relativeTranslationPath] = {
        sourceHash: hash,
        sourcePath: relativePath,
        configSignature,
        paragraphs: [],
        savedAt: now,
        lastAccessedAt: now,
        sizeBytes: await this.getFileSize(translationPath),
      };

      await this.writeExtendedMetadata(extended);
    });

    return translationPath;
  }

  /**
   * 保存翻译并记录段落映射
   */
  async saveTranslationWithMapping(
    sourcePath: string,
    content: string,
    translatedContent: string,
    paragraphs: ParagraphMapping[],
    sourceLanguage?: string,
    configSignature: string = 'default'
  ): Promise<string> {
    const translationPath = this.getTranslationPath(sourcePath, configSignature);
    const translationDir = path.dirname(translationPath);

    await this.ensureDir(translationDir);
    await fs.writeFile(translationPath, translatedContent, 'utf-8');

    const now = Date.now();
    const hash = this.calculateHash(content);

    await this.queueMetadataWrite(async () => {
      const extended = await this.readExtendedMetadata();
      const relativePath = path.relative(this.workspaceRoot, sourcePath);
      const cacheKey = this.getCacheKey(sourcePath, configSignature);
      const relativeTranslationPath = path.relative(this.translationDir, translationPath);

      extended.hashes[cacheKey] = hash;
      extended.translations[relativeTranslationPath] = {
        sourceHash: hash,
        sourcePath: relativePath,
        configSignature,
        sourceLanguage,
        paragraphs,
        savedAt: now,
        lastAccessedAt: now,
        sizeBytes: await this.getFileSize(translationPath),
      };

      await this.writeExtendedMetadata(extended);
    });

    return translationPath;
  }

  /**
   * 获取段落映射
   */
  async getParagraphMapping(translationPath: string): Promise<TranslationMetadata | null> {
    await this.queueMetadataWrite(async () => {
      const extended = await this.readExtendedMetadata();
      const relativeTranslationPath = path.relative(this.translationDir, translationPath);
      const metadata = extended.translations[relativeTranslationPath];

      if (metadata) {
        metadata.lastAccessedAt = Date.now();
        metadata.sizeBytes = await this.getFileSize(translationPath);
        await this.writeExtendedMetadata(extended);
      }
    });

    const extended = await this.readExtendedMetadata();
    const relativeTranslationPath = path.relative(this.translationDir, translationPath);
    return extended.translations[relativeTranslationPath] || null;
  }

  /**
   * 更新段落映射（反向翻译后调用）
   */
  async updateParagraphMapping(
    translationPath: string,
    paragraphs: ParagraphMapping[],
    newSourceContent: string
  ): Promise<void> {
    return this.queueMetadataWrite(async () => {
      const extended = await this.readExtendedMetadata();
      const relativeTranslationPath = path.relative(this.translationDir, translationPath);
      const metadata = extended.translations[relativeTranslationPath];

      if (metadata) {
        const sourcePath = path.join(this.workspaceRoot, metadata.sourcePath);
        metadata.paragraphs = paragraphs;
        metadata.sourceHash = this.calculateHash(newSourceContent);
        metadata.lastAccessedAt = Date.now();
        metadata.sizeBytes = await this.getFileSize(translationPath);
        extended.hashes[this.getCacheKey(sourcePath, metadata.configSignature ?? 'default')] =
          metadata.sourceHash;
        await this.writeExtendedMetadata(extended);
      }
    });
  }

  async getExistingTranslation(
    sourcePath: string,
    configSignature: string = 'default'
  ): Promise<string | null> {
    const translationPath = this.getTranslationPath(sourcePath, configSignature);
    try {
      const content = await fs.readFile(translationPath, 'utf-8');
      await this.markTranslationAccessed(translationPath);
      return content;
    } catch {
      return null;
    }
  }

  async cleanCache(options: CacheCleanupOptions): Promise<CacheCleanupResult> {
    const extended = await this.readExtendedMetadata();
    const now = options.now ?? Date.now();
    const retentionMs = options.retentionDays > 0 ? options.retentionDays * 24 * 60 * 60 * 1000 : 0;
    const maxSizeBytes = options.maxSizeMB > 0 ? options.maxSizeMB * 1024 * 1024 : 0;
    const protectedPaths = new Set((options.protectedPaths ?? []).map(p => path.normalize(p)));

    let entries = await this.getCacheEntries(extended);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    let deletedFiles = 0;
    let deletedBytes = 0;

    const deleteAndTrack = async (entry: CacheEntry): Promise<void> => {
      if (protectedPaths.has(path.normalize(entry.translationPath))) {
        return;
      }

      const result = await this.deleteEntry(extended, entry);
      deletedFiles += result.deletedFiles;
      deletedBytes += result.deletedBytes;
      totalBytes = Math.max(0, totalBytes - result.deletedBytes);
    };

    for (const entry of entries) {
      const sourcePath = path.join(this.workspaceRoot, entry.metadata.sourcePath);
      const sourceExists = await fs
        .access(sourcePath)
        .then(() => true)
        .catch(() => false);

      if (!sourceExists) {
        await deleteAndTrack(entry);
      }
    }

    entries = await this.getCacheEntries(extended);

    if (retentionMs > 0) {
      for (const entry of entries) {
        if (now - entry.lastAccessedAt > retentionMs) {
          await deleteAndTrack(entry);
        }
      }
    }

    entries = await this.getCacheEntries(extended);

    if (maxSizeBytes > 0 && totalBytes > maxSizeBytes) {
      const sortedEntries = [...entries].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      for (const entry of sortedEntries) {
        if (totalBytes <= maxSizeBytes) {
          break;
        }
        await deleteAndTrack(entry);
      }
    }

    await this.writeExtendedMetadata(extended);

    return {
      deletedFiles,
      deletedBytes,
      remainingBytes: totalBytes,
    };
  }

  async clearCache(): Promise<CacheCleanupResult> {
    const entries = await this.getCacheEntries(await this.readExtendedMetadata());
    const deletedBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const deletedFiles = entries.length;

    await fs.rm(this.translationDir, { recursive: true, force: true });
    await this.ensureDir(this.translationDir);
    await fs.writeFile(this.migrationMarkerPath, '', 'utf-8');

    return {
      deletedFiles,
      deletedBytes,
      remainingBytes: 0,
    };
  }
}
