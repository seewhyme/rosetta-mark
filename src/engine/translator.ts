import { AIService } from '../ai/service';
import { MarkdownParser, ParsedParagraph } from './parser';
import {
  TranslationConfig,
  TranslationResult,
  ParagraphMapping,
  IncrementalTranslationResult,
  TranslationProgress
} from '../types';

export interface TranslationWithMapping {
  result: TranslationResult;
  paragraphs: ParagraphMapping[];
  sourceLanguage?: string;
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

    type PendingTranslationGroup = Array<{ index: number; paragraph: ParsedParagraph }>;

    // 找出需要翻译的段落
    const translationGroups: PendingTranslationGroup[] = [];
    const resultParagraphs: ParagraphMapping[] = [];
    let currentGroup: PendingTranslationGroup = [];

    const flushCurrentGroup = () => {
      if (currentGroup.length > 0) {
        translationGroups.push(currentGroup);
        currentGroup = [];
      }
    };

    for (let i = 0; i < currentParagraphs.length; i++) {
      const paragraph = currentParagraphs[i];

      // 代码块和 frontmatter 不需要翻译
      if (paragraph.type !== 'text') {
        flushCurrentGroup();
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
        flushCurrentGroup();
        resultParagraphs.push(existing);
      } else {
        currentGroup.push({ index: i, paragraph });
        resultParagraphs.push({
          sourceContent: paragraph.content,
          translatedContent: '', // 待填充
          sourceHash: paragraph.hash,
        });
      }
    }
    flushCurrentGroup();

    const paragraphsToTranslateCount = translationGroups.reduce((count, group) => count + group.length, 0);
    const reusedCount = totalParagraphs - paragraphsToTranslateCount;
    const totalTokenUsage = { prompt: 0, completion: 0, total: 0 };

    onProgress?.({
      current: reusedCount,
      total: totalParagraphs,
      phase: 'translating',
      message: `Reusing ${reusedCount} cached paragraphs, translating ${paragraphsToTranslateCount}...`,
    });

    // 并行翻译需要翻译的段落
    if (translationGroups.length > 0) {
      let translatedCount = 0;

      for (const group of translationGroups) {
        const textsToTranslate = group.map(item => item.paragraph.content);

        const results = await this.aiService.translateParagraphs(textsToTranslate, {
          signal,
          maxConcurrency,
          glossary: this.config.glossary,
          onParagraphProgress: (current) => {
            onProgress?.({
              current: reusedCount + translatedCount + current,
              total: totalParagraphs,
              phase: 'translating',
              message: `Translating paragraph ${translatedCount + current}/${paragraphsToTranslateCount}...`,
            });
          },
        });

        for (let i = 0; i < group.length; i++) {
          const { index } = group[i];
          const result = results[i];

          resultParagraphs[index].translatedContent = result.translatedText;

          if (result.tokenUsage) {
            totalTokenUsage.prompt += result.tokenUsage.prompt;
            totalTokenUsage.completion += result.tokenUsage.completion;
            totalTokenUsage.total += result.tokenUsage.total;
          }
        }

        translatedCount += group.length;
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
      changedParagraphs: paragraphsToTranslateCount,
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
