import { AIService, TranslateOptions } from '../ai/service';
import { MarkdownParser, ParsedParagraph } from './parser';
import {
  TranslationConfig,
  TranslationResult,
  ParagraphMapping,
  IncrementalTranslationResult,
  TranslationError,
  TranslationErrorCode,
  TranslationProgress
} from '../types';

export interface TranslationWithMapping {
  result: TranslationResult;
  paragraphs: ParagraphMapping[];
  sourceLanguage?: string;
}

export interface ReverseTranslationResult {
  modifiedIndices: number[];
  translatedParagraphs: { index: number; content: string }[];
  newSourceContent: string;
  newParagraphs: ParagraphMapping[];
}

export interface IncrementalTranslateOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TranslationProgress) => void;
  existingParagraphs?: ParagraphMapping[];
  maxConcurrency?: number;
}

export class TranslationEngine {
  private aiService: AIService;
  private parser: MarkdownParser;
  private config: TranslationConfig;

  constructor(config: TranslationConfig) {
    this.config = config;
    this.aiService = new AIService(config);
    this.parser = new MarkdownParser();
  }

  async translate(content: string, onProgress?: (chunk: string) => void): Promise<TranslationResult> {
    // 提取代码块
    const extracted = this.parser.extractTextForTranslation(content);

    // 只翻译非代码部分
    const result = await this.aiService.translate(extracted.translatableText, { onProgress });

    // 还原代码块
    const finalText = this.parser.restoreCodeBlocks(result.translatedText, extracted);

    return {
      ...result,
      translatedText: finalText,
    };
  }

  /**
   * 增量翻译：只翻译变化的段落
   */
  async translateIncremental(
    content: string,
    options?: IncrementalTranslateOptions
  ): Promise<IncrementalTranslationResult> {
    const { signal, onProgress, existingParagraphs, maxConcurrency = 3 } = options || {};

    // 解析当前内容为段落
    const currentParagraphs = this.parser.splitIntoParagraphsWithHash(content);
    const totalParagraphs = currentParagraphs.length;

    onProgress?.({
      current: 0,
      total: totalParagraphs,
      phase: 'parsing',
      message: 'Analyzing document structure...',
    });

    // 创建现有段落的 hash 映射
    const existingHashMap = new Map<string, ParagraphMapping>();
    if (existingParagraphs) {
      for (const p of existingParagraphs) {
        existingHashMap.set(p.sourceHash, p);
      }
    }

    // 找出需要翻译的段落
    const paragraphsToTranslate: { index: number; paragraph: ParsedParagraph }[] = [];
    const resultParagraphs: ParagraphMapping[] = [];

    for (let i = 0; i < currentParagraphs.length; i++) {
      const paragraph = currentParagraphs[i];

      // 代码块不需要翻译
      if (paragraph.type === 'code') {
        resultParagraphs.push({
          sourceContent: paragraph.content,
          translatedContent: paragraph.content,
          sourceHash: paragraph.hash,
        });
        continue;
      }

      // 检查是否有现有翻译
      const existing = existingHashMap.get(paragraph.hash);
      if (existing) {
        resultParagraphs.push(existing);
      } else {
        paragraphsToTranslate.push({ index: i, paragraph });
        resultParagraphs.push({
          sourceContent: paragraph.content,
          translatedContent: '', // 待填充
          sourceHash: paragraph.hash,
        });
      }
    }

    const reusedCount = totalParagraphs - paragraphsToTranslate.length;
    let totalTokenUsage = { prompt: 0, completion: 0, total: 0 };

    onProgress?.({
      current: reusedCount,
      total: totalParagraphs,
      phase: 'translating',
      message: `Reusing ${reusedCount} cached paragraphs, translating ${paragraphsToTranslate.length}...`,
    });

    // 并行翻译需要翻译的段落
    if (paragraphsToTranslate.length > 0) {
      const textsToTranslate = paragraphsToTranslate.map(p => p.paragraph.content);

      const results = await this.aiService.translateParagraphs(textsToTranslate, {
        signal,
        maxConcurrency,
        glossary: this.config.glossary,
        onParagraphProgress: (current, total) => {
          onProgress?.({
            current: reusedCount + current,
            total: totalParagraphs,
            phase: 'translating',
            message: `Translating paragraph ${current}/${total}...`,
          });
        },
      });

      // 填充翻译结果
      for (let i = 0; i < paragraphsToTranslate.length; i++) {
        const { index } = paragraphsToTranslate[i];
        const result = results[i];

        resultParagraphs[index].translatedContent = result.translatedText;

        if (result.tokenUsage) {
          totalTokenUsage.prompt += result.tokenUsage.prompt;
          totalTokenUsage.completion += result.tokenUsage.completion;
          totalTokenUsage.total += result.tokenUsage.total;
        }
      }
    }

    onProgress?.({
      current: totalParagraphs,
      total: totalParagraphs,
      phase: 'saving',
      message: 'Finalizing translation...',
    });

    // 组合最终翻译结果
    const translatedText = resultParagraphs
      .map(p => p.translatedContent)
      .join('\n\n');

    return {
      translatedText,
      paragraphs: resultParagraphs,
      changedParagraphs: paragraphsToTranslate.length,
      reusedParagraphs: reusedCount,
      tokenUsage: totalTokenUsage.total > 0 ? totalTokenUsage : undefined,
    };
  }

  /**
   * 翻译并返回段落映射（兼容旧接口）
   */
  async translateWithMapping(
    content: string,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<TranslationWithMapping> {
    // 使用增量翻译
    let accumulatedText = '';
    const result = await this.translateIncremental(content, {
      signal,
      onProgress: (progress) => {
        if (progress.phase === 'translating' && onProgress) {
          const newText = progress.message;
          if (newText !== accumulatedText) {
            onProgress(newText.slice(accumulatedText.length));
            accumulatedText = newText;
          }
        }
      },
    });

    // 检测原文语言
    let sourceLanguage: string | undefined;
    try {
      sourceLanguage = await this.aiService.detectLanguage(content);
    } catch {
      // 语言检测失败不影响主流程
    }

    return {
      result: {
        translatedText: result.translatedText,
        tokenUsage: result.tokenUsage,
      },
      paragraphs: result.paragraphs,
      sourceLanguage,
    };
  }

  /**
   * 带现有翻译的增量翻译
   */
  async translateWithExisting(
    content: string,
    existingParagraphs: ParagraphMapping[],
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: TranslationProgress) => void;
    }
  ): Promise<IncrementalTranslationResult> {
    return this.translateIncremental(content, {
      ...options,
      existingParagraphs,
      maxConcurrency: this.config.maxConcurrency,
    });
  }

  /**
   * 反向翻译：检测修改的段落并翻译回原文语言
   */
  async reverseTranslate(
    currentTranslatedContent: string,
    savedParagraphs: ParagraphMapping[],
    sourceLanguage: string,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<ReverseTranslationResult> {
    // 拆分当前译文为段落
    const currentParagraphs = this.parser.splitIntoParagraphs(currentTranslatedContent);

    // 找出修改的段落
    const modifiedIndices: number[] = [];
    for (let i = 0; i < currentParagraphs.length; i++) {
      const savedParagraph = savedParagraphs[i];
      if (!savedParagraph || currentParagraphs[i] !== savedParagraph.translatedContent) {
        modifiedIndices.push(i);
      }
    }

    if (modifiedIndices.length === 0) {
      // 没有修改
      const sourceParagraphContents = savedParagraphs.map(p => p.sourceContent);
      return {
        modifiedIndices: [],
        translatedParagraphs: [],
        newSourceContent: this.parser.joinParagraphs(sourceParagraphContents),
        newParagraphs: savedParagraphs,
      };
    }

    // 并行翻译修改的段落
    const paragraphsToTranslate = modifiedIndices.map(i => currentParagraphs[i]);
    const translatedParagraphs: { index: number; content: string }[] = [];

    const results = await this.aiService.translateParagraphs(paragraphsToTranslate, {
      signal,
      maxConcurrency: this.config.maxConcurrency || 3,
      onParagraphProgress: (current, total) => {
        onProgress?.(`Translating paragraph ${current}/${total}...`);
      },
    });

    for (let i = 0; i < modifiedIndices.length; i++) {
      translatedParagraphs.push({
        index: modifiedIndices[i],
        content: results[i].translatedText,
      });
    }

    // 构建新的原文内容和段落映射
    const newParagraphs: ParagraphMapping[] = savedParagraphs.map(p => ({
      ...p,
      sourceHash: p.sourceHash || this.parser.calculateHash(p.sourceContent),
    }));
    const sourceParagraphContents: string[] = savedParagraphs.map(p => p.sourceContent);

    for (const { index, content } of translatedParagraphs) {
      // 更新原文段落
      if (index < sourceParagraphContents.length) {
        sourceParagraphContents[index] = content;
      } else {
        sourceParagraphContents.push(content);
      }

      // 更新段落映射
      if (index < newParagraphs.length) {
        newParagraphs[index] = {
          sourceContent: content,
          translatedContent: currentParagraphs[index],
          sourceHash: this.parser.calculateHash(content),
        };
      } else {
        newParagraphs.push({
          sourceContent: content,
          translatedContent: currentParagraphs[index],
          sourceHash: this.parser.calculateHash(content),
        });
      }
    }

    const newSourceContent = this.parser.joinParagraphs(sourceParagraphContents);

    return {
      modifiedIndices,
      translatedParagraphs,
      newSourceContent,
      newParagraphs,
    };
  }

  /**
   * 验证 API Key
   */
  async validateApiKey(): Promise<boolean> {
    return this.aiService.validateApiKey();
  }

  /**
   * 检查文档大小
   */
  checkDocumentSize(content: string): { valid: boolean; estimatedTokens: number; message?: string } {
    const estimatedTokens = this.parser.estimateTokens(content);
    const maxTokens = 100000;

    if (estimatedTokens > maxTokens) {
      return {
        valid: false,
        estimatedTokens,
        message: `Document is too large (estimated ${estimatedTokens} tokens). Maximum is ${maxTokens} tokens.`,
      };
    }

    return { valid: true, estimatedTokens };
  }
}
