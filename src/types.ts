export type ProviderType = 'openai' | 'google' | 'anthropic' | 'ollama' | 'openrouter';
export type PreviewMode = 'editor' | 'preview' | 'both';
export type ConfigScope = 'workspace' | 'global';

export interface TranslationConfig {
  provider: ProviderType;
  model: string;
  apiKey: string;
  baseUrl?: string;
  targetLanguage: string;
  glossary?: GlossaryEntry[];
  maxConcurrency?: number;
}

export interface TranslationResult {
  translatedText: string;
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface ParagraphMapping {
  sourceContent: string;      // 原文段落内容
  translatedContent: string;  // 译文段落内容
  sourceHash: string;         // 原文段落 hash，用于增量翻译
}

export interface TranslationMetadata {
  sourceHash: string;             // 原文件整体 hash
  sourcePath: string;             // 原文件相对路径
  sourceLanguage?: string;        // 检测到的原文语言
  paragraphs: ParagraphMapping[]; // 段落对应关系
  detectedAt?: number;            // 语言检测时间戳
}

export interface GlossaryEntry {
  source: string;      // 原文术语
  target: string;      // 译文术语
  caseSensitive?: boolean;
}

export interface TranslationProgress {
  current: number;
  total: number;
  phase: 'parsing' | 'translating' | 'saving';
  message: string;
}

export interface IncrementalTranslationResult {
  translatedText: string;
  paragraphs: ParagraphMapping[];
  changedParagraphs: number;
  reusedParagraphs: number;
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export class TranslationError extends Error {
  constructor(
    message: string,
    public readonly code: TranslationErrorCode,
    public readonly retryable: boolean = false,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}

export enum TranslationErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  AUTH_ERROR = 'AUTH_ERROR',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  CANCELLED = 'CANCELLED',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  UNKNOWN = 'UNKNOWN',
}
