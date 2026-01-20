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

export class FileSystemManager {
  private workspaceRoot: string;
  private translationDir: string;
  private metadataPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.translationDir = path.join(workspaceRoot, '.rosetta-mark');
    this.metadataPath = path.join(this.translationDir, 'metadata.json');
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
      return parsed;
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

  getTranslationPath(sourcePath: string): string {
    const relativePath = path.relative(this.workspaceRoot, sourcePath);
    return path.join(this.translationDir, relativePath);
  }

  /**
   * 从翻译文件路径获取原文件路径
   */
  getSourcePathFromTranslation(translationPath: string): string | null {
    const relativePath = path.relative(this.translationDir, translationPath);
    if (relativePath.startsWith('..')) {
      return null; // 不是翻译文件
    }
    return path.join(this.workspaceRoot, relativePath);
  }

  /**
   * 判断给定路径是否为翻译文件
   */
  isTranslationFile(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    const normalizedTranslationDir = path.normalize(this.translationDir);
    return normalizedPath.startsWith(normalizedTranslationDir + path.sep);
  }

  /**
   * 获取翻译目录路径
   */
  getTranslationDir(): string {
    return this.translationDir;
  }

  async needsTranslation(sourcePath: string, content: string): Promise<boolean> {
    const hash = this.calculateHash(content);
    const metadata = await this.readMetadata();
    const relativePath = path.relative(this.workspaceRoot, sourcePath);

    const translationPath = this.getTranslationPath(sourcePath);
    const translationExists = await fs.access(translationPath).then(() => true).catch(() => false);

    if (!translationExists) {
      return true;
    }

    return metadata[relativePath] !== hash;
  }

  async saveTranslation(sourcePath: string, content: string, translatedContent: string): Promise<string> {
    const translationPath = this.getTranslationPath(sourcePath);
    const translationDir = path.dirname(translationPath);

    await this.ensureDir(translationDir);
    await fs.writeFile(translationPath, translatedContent, 'utf-8');

    const hash = this.calculateHash(content);
    const metadata = await this.readMetadata();
    const relativePath = path.relative(this.workspaceRoot, sourcePath);
    metadata[relativePath] = hash;
    await this.writeMetadata(metadata);

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
    sourceLanguage?: string
  ): Promise<string> {
    const translationPath = this.getTranslationPath(sourcePath);
    const translationDir = path.dirname(translationPath);

    await this.ensureDir(translationDir);
    await fs.writeFile(translationPath, translatedContent, 'utf-8');

    const hash = this.calculateHash(content);
    const extended = await this.readExtendedMetadata();
    const relativePath = path.relative(this.workspaceRoot, sourcePath);
    const relativeTranslationPath = path.relative(this.translationDir, translationPath);

    extended.hashes[relativePath] = hash;
    extended.translations[relativeTranslationPath] = {
      sourceHash: hash,
      sourcePath: relativePath,
      sourceLanguage,
      paragraphs
    };

    await this.writeExtendedMetadata(extended);

    return translationPath;
  }

  /**
   * 获取段落映射
   */
  async getParagraphMapping(translationPath: string): Promise<TranslationMetadata | null> {
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
    const extended = await this.readExtendedMetadata();
    const relativeTranslationPath = path.relative(this.translationDir, translationPath);
    const metadata = extended.translations[relativeTranslationPath];

    if (metadata) {
      metadata.paragraphs = paragraphs;
      metadata.sourceHash = this.calculateHash(newSourceContent);
      extended.hashes[metadata.sourcePath] = metadata.sourceHash;
      await this.writeExtendedMetadata(extended);
    }
  }

  async getExistingTranslation(sourcePath: string): Promise<string | null> {
    const translationPath = this.getTranslationPath(sourcePath);
    try {
      return await fs.readFile(translationPath, 'utf-8');
    } catch {
      return null;
    }
  }
}
