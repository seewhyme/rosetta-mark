import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import {
  TranslationConfig,
  TranslationResult,
  GlossaryEntry,
  TranslationError,
  TranslationErrorCode,
} from '../types';

const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RATE_LIMIT_DELAY_MS = 60000;

export interface TranslateOptions {
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
  glossary?: GlossaryEntry[];
}

interface TokenUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export class AIService {
  private config: TranslationConfig;
  private languageCache: Map<string, { language: string; timestamp: number }> = new Map();
  private readonly LANGUAGE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(config: TranslationConfig) {
    this.config = config;
  }

  private getProvider() {
    const { provider, apiKey, baseUrl, model } = this.config;

    switch (provider) {
      case 'openai': {
        const openai = createOpenAI({
          apiKey,
          baseURL: baseUrl || undefined,
        });
        return openai(model);
      }
      case 'google': {
        const google = createGoogleGenerativeAI({
          apiKey,
        });
        return google(model);
      }
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey,
          baseURL: baseUrl || undefined,
        });
        return anthropic(model);
      }
      case 'ollama': {
        const ollama = createOpenAI({
          apiKey: 'ollama',
          baseURL: baseUrl || 'http://localhost:11434/v1',
        });
        return ollama(model);
      }
      case 'openrouter': {
        const openrouter = createOpenAI({
          apiKey,
          baseURL: baseUrl || 'https://openrouter.ai/api/v1',
        });
        return openrouter(model);
      }
      default:
        throw new TranslationError(
          `Unsupported provider: ${provider}`,
          TranslationErrorCode.UNKNOWN
        );
    }
  }

  private buildSystemPrompt(targetLanguage: string, glossary?: GlossaryEntry[]): string {
    let prompt =
      `Translate Markdown to ${targetLanguage}. ` +
      `Preserve all Markdown syntax, spacing, code blocks, inline literals, placeholders, HTML/XML tags, and segment ids. ` +
      `Do not translate code, identifiers inside code, Markdown punctuation, placeholders, or HTML/XML tags. ` +
      `If <segment id="N"> blocks are present, translate only their inner text and keep tags/order unchanged. ` +
      `Return only the translated Markdown.`;

    if (glossary && glossary.length > 0) {
      prompt += '\nGlossary:\n';
      for (const entry of glossary) {
        prompt += `${entry.source} → ${entry.target}${entry.caseSensitive ? ' (cs)' : ''}\n`;
      }
    }

    return prompt;
  }

  private buildMessages(systemPrompt: string, content: string) {
    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content },
    ];
  }

  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  private convertTokenUsage(usage?: TokenUsageLike) {
    if (
      usage?.promptTokens === undefined ||
      usage.completionTokens === undefined ||
      usage.totalTokens === undefined
    ) {
      return undefined;
    }

    return {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    };
  }

  private classifyError(error: unknown): TranslationError {
    if (error instanceof TranslationError) {
      return error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes('rate limit') || lowerMessage.includes('429')) {
      return new TranslationError(
        'Rate limit exceeded. Please wait before retrying.',
        TranslationErrorCode.RATE_LIMIT,
        true,
        error instanceof Error ? error : undefined
      );
    }

    if (
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('401') ||
      lowerMessage.includes('invalid api key') ||
      lowerMessage.includes('authentication')
    ) {
      return new TranslationError(
        'Authentication failed. Please check your API key.',
        TranslationErrorCode.AUTH_ERROR,
        false,
        error instanceof Error ? error : undefined
      );
    }

    if (
      lowerMessage.includes('network') ||
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('enotfound')
    ) {
      return new TranslationError(
        'Network error. Please check your connection.',
        TranslationErrorCode.NETWORK_ERROR,
        true,
        error instanceof Error ? error : undefined
      );
    }

    if (lowerMessage.includes('abort') || lowerMessage.includes('cancel')) {
      return new TranslationError(
        'Translation was cancelled.',
        TranslationErrorCode.CANCELLED,
        false,
        error instanceof Error ? error : undefined
      );
    }

    return new TranslationError(
      errorMessage,
      TranslationErrorCode.UNKNOWN,
      true,
      error instanceof Error ? error : undefined
    );
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = DEFAULT_MAX_RETRIES,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: TranslationError | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new TranslationError('Translation was cancelled.', TranslationErrorCode.CANCELLED);
      }

      try {
        return await operation();
      } catch (error) {
        lastError = this.classifyError(error);

        if (!lastError.retryable) {
          throw lastError;
        }

        if (attempt < maxRetries - 1) {
          const delay =
            lastError.code === TranslationErrorCode.RATE_LIMIT
              ? RATE_LIMIT_DELAY_MS
              : RETRY_DELAY_MS * Math.pow(2, attempt);

          console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  async translate(content: string, options?: TranslateOptions): Promise<TranslationResult> {
    const { onProgress, signal, glossary } = options || {};
    const model = this.getProvider();
    const systemPrompt = this.buildSystemPrompt(
      this.config.targetLanguage,
      glossary || this.config.glossary
    );

    return this.withRetry(
      async () => {
        if (onProgress) {
          let translatedText = '';
          const { textStream, usage } = await streamText({
            model,
            messages: this.buildMessages(systemPrompt, content),
            abortSignal: signal,
          });

          for await (const chunk of textStream) {
            if (signal?.aborted) {
              throw new TranslationError(
                'Translation was cancelled.',
                TranslationErrorCode.CANCELLED
              );
            }
            translatedText += chunk;
            onProgress(chunk);
          }

          const usageData = await usage;

          return {
            translatedText,
            tokenUsage: this.convertTokenUsage(usageData),
          };
        } else {
          const { text, usage } = await generateText({
            model,
            messages: this.buildMessages(systemPrompt, content),
            abortSignal: signal,
          });

          return {
            translatedText: text,
            tokenUsage: this.convertTokenUsage(usage),
          };
        }
      },
      DEFAULT_MAX_RETRIES,
      signal
    );
  }

  async detectLanguage(content: string, cacheKey?: string): Promise<string> {
    // Check cache first
    if (cacheKey) {
      const cached = this.languageCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.LANGUAGE_CACHE_TTL) {
        return cached.language;
      }
    }

    const model = this.getProvider();

    const result = await this.withRetry(async () => {
      const { text } = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Return only the BCP-47 language code of the input (e.g. en, zh-CN, ja). No other output.',
          },
          {
            role: 'user',
            content: content.substring(0, 500),
          },
        ],
      });

      return text.trim();
    });

    // Cache the result
    if (cacheKey) {
      this.languageCache.set(cacheKey, {
        language: result,
        timestamp: Date.now(),
      });
    }

    return result;
  }

  async translateTo(
    content: string,
    targetLanguage: string,
    options?: TranslateOptions
  ): Promise<TranslationResult> {
    const { onProgress, signal, glossary } = options || {};
    const model = this.getProvider();
    const systemPrompt = this.buildSystemPrompt(targetLanguage, glossary);

    return this.withRetry(
      async () => {
        if (onProgress) {
          let translatedText = '';
          const { textStream, usage } = await streamText({
            model,
            messages: this.buildMessages(systemPrompt, content),
            abortSignal: signal,
          });

          for await (const chunk of textStream) {
            if (signal?.aborted) {
              throw new TranslationError(
                'Translation was cancelled.',
                TranslationErrorCode.CANCELLED
              );
            }
            translatedText += chunk;
            onProgress(chunk);
          }

          const usageData = await usage;

          return {
            translatedText,
            tokenUsage: this.convertTokenUsage(usageData),
          };
        } else {
          const { text, usage } = await generateText({
            model,
            messages: this.buildMessages(systemPrompt, content),
            abortSignal: signal,
          });

          return {
            translatedText: text,
            tokenUsage: this.convertTokenUsage(usage),
          };
        }
      },
      DEFAULT_MAX_RETRIES,
      signal
    );
  }

  async translateParagraphs(
    paragraphs: string[],
    options?: TranslateOptions & {
      maxConcurrency?: number;
      onParagraphProgress?: (current: number, total: number) => void;
      maxBatchTokens?: number;
    }
  ): Promise<TranslationResult[]> {
    const {
      signal,
      maxConcurrency = this.config.maxConcurrency ?? 4,
      onParagraphProgress,
      maxBatchTokens = this.config.maxBatchTokens ?? 4000,
    } = options || {};
    const glossary = options?.glossary;

    const results: TranslationResult[] = new Array(paragraphs.length);

    // 1. 预先构建静态 batch 队列
    type Batch = { startIndex: number; items: string[] };
    const batches: Batch[] = [];
    let i = 0;
    while (i < paragraphs.length) {
      const startIndex = i;
      const items = [paragraphs[i]];
      let tokens = this.estimateTokens(paragraphs[i]);
      i++;
      while (
        i < paragraphs.length &&
        tokens + this.estimateTokens(paragraphs[i]) <= maxBatchTokens
      ) {
        items.push(paragraphs[i]);
        tokens += this.estimateTokens(paragraphs[i]);
        i++;
      }
      batches.push({ startIndex, items });
    }

    let cursor = 0;
    let completed = 0;

    const finish = (index: number, result: TranslationResult) => {
      results[index] = result;
      completed++;
      onParagraphProgress?.(completed, paragraphs.length);
    };

    const checkAbort = () => {
      if (signal?.aborted) {
        throw new TranslationError('Translation was cancelled.', TranslationErrorCode.CANCELLED);
      }
    };

    // 2. 单段翻译（worker 内复用）
    const translateOne = async (index: number, content: string) => {
      finish(index, await this.translate(content, { signal, glossary }));
    };

    // 3. batch 翻译：成功段直接 finish，失败段在当前 worker 内串行 repair
    //    （不裸 Promise.all，避免突破 maxConcurrency）
    const translateBatch = async (batch: Batch) => {
      if (batch.items.length === 1) {
        await translateOne(batch.startIndex, batch.items[0]);
        return;
      }

      const tagged = batch.items
        .map((c, o) => `<segment id="${batch.startIndex + o}">\n${c}\n</segment>`)
        .join('\n\n');

      const batchResult = await this.translate(tagged, { signal, glossary });

      const matches = new Map<number, string>();
      for (const m of batchResult.translatedText.matchAll(
        /<segment\s+id="(\d+)"\s*>\s*([\s\S]*?)\s*<\/segment>/g
      )) {
        matches.set(Number(m[1]), m[2]);
      }

      const missing: Array<{ index: number; content: string }> = [];
      let firstSuccess = true;
      for (let o = 0; o < batch.items.length; o++) {
        const idxAbs = batch.startIndex + o;
        const text = matches.get(idxAbs);
        if (text !== undefined) {
          finish(idxAbs, {
            translatedText: text,
            tokenUsage: firstSuccess ? batchResult.tokenUsage : undefined,
          });
          firstSuccess = false;
        } else {
          missing.push({ index: idxAbs, content: batch.items[o] });
        }
      }

      // 当前 worker 内串行修复——天然受 maxConcurrency 限制，行为简单可预测
      for (const m of missing) {
        checkAbort();
        await translateOne(m.index, m.content);
      }
    };

    // 4. worker pool：N 个常驻 worker 共享静态队列，无批屏障
    const worker = async () => {
      for (;;) {
        checkAbort();
        const idx = cursor++;
        if (idx >= batches.length) {
          return;
        }
        await translateBatch(batches[idx]);
      }
    };

    const workerCount = Math.min(maxConcurrency, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Simple validation by making a minimal API call
      await this.detectLanguage('Hello world');
      return true;
    } catch (error) {
      const translationError = this.classifyError(error);
      if (translationError.code === TranslationErrorCode.AUTH_ERROR) {
        return false;
      }
      // For other errors (network, etc.), we can't determine validity
      throw translationError;
    }
  }

  clearLanguageCache(): void {
    this.languageCache.clear();
  }
}
