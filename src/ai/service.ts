import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import {
  TranslationConfig,
  TranslationResult,
  GlossaryEntry,
  TranslationError,
  TranslationErrorCode
} from '../types';

const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RATE_LIMIT_DELAY_MS = 60000;

export interface TranslateOptions {
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
  glossary?: GlossaryEntry[];
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
    let prompt = `You are a professional technical translator. Translate the markdown content to ${targetLanguage}.

CRITICAL RULES:
1. DO NOT translate code blocks (content within \`\`\` fences)
2. DO NOT translate inline code (content within single backticks)
3. DO NOT translate frontmatter keys (YAML keys in the header)
4. DO NOT translate HTML attributes
5. DO NOT add any explanations or extra content
6. Maintain original formatting strictly (line breaks, indentation, lists, headers)
7. Only output the translated markdown, nothing else

Your goal is to provide a clean, accurate translation that preserves all technical elements and formatting.`;

    if (glossary && glossary.length > 0) {
      prompt += '\n\nGLOSSARY - Use these exact translations for the following terms:\n';
      for (const entry of glossary) {
        prompt += `- "${entry.source}" → "${entry.target}"${entry.caseSensitive ? ' (case-sensitive)' : ''}\n`;
      }
    }

    return prompt;
  }

  private getSystemPrompt(glossary?: GlossaryEntry[]): string {
    return this.buildSystemPrompt(this.config.targetLanguage, glossary);
  }

  private buildMessages(systemPrompt: string, content: string) {
    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: `Translate the following markdown:\n\n${content}` }
    ];
  }

  private convertTokenUsage(usage: any) {
    return usage ? {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    } : undefined;
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

    if (lowerMessage.includes('unauthorized') || lowerMessage.includes('401') ||
      lowerMessage.includes('invalid api key') || lowerMessage.includes('authentication')) {
      return new TranslationError(
        'Authentication failed. Please check your API key.',
        TranslationErrorCode.AUTH_ERROR,
        false,
        error instanceof Error ? error : undefined
      );
    }

    if (lowerMessage.includes('network') || lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('timeout') || lowerMessage.includes('enotfound')) {
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
        throw new TranslationError(
          'Translation was cancelled.',
          TranslationErrorCode.CANCELLED
        );
      }

      try {
        return await operation();
      } catch (error) {
        lastError = this.classifyError(error);

        if (!lastError.retryable) {
          throw lastError;
        }

        if (attempt < maxRetries - 1) {
          const delay = lastError.code === TranslationErrorCode.RATE_LIMIT
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
    const systemPrompt = this.getSystemPrompt(glossary || this.config.glossary);

    return this.withRetry(async () => {
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
    }, DEFAULT_MAX_RETRIES, signal);
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
            content: `You are a language detection expert. Detect the primary language of the given text and respond with ONLY the language code (e.g., "en" for English, "zh-CN" for Simplified Chinese, "ja" for Japanese, "ko" for Korean, "fr" for French, "de" for German, "es" for Spanish, etc.). Do not include any other text or explanation.`
          },
          {
            role: 'user',
            content: `Detect the language of this text:\n\n${content.substring(0, 500)}`
          }
        ],
      });

      return text.trim();
    });

    // Cache the result
    if (cacheKey) {
      this.languageCache.set(cacheKey, {
        language: result,
        timestamp: Date.now()
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

    return this.withRetry(async () => {
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
    }, DEFAULT_MAX_RETRIES, signal);
  }

  async translateParagraphs(
    paragraphs: string[],
    options?: TranslateOptions & {
      maxConcurrency?: number;
      onParagraphProgress?: (index: number, total: number) => void;
    }
  ): Promise<TranslationResult[]> {
    const { signal, maxConcurrency = 3, onParagraphProgress } = options || {};
    const results: TranslationResult[] = new Array(paragraphs.length);

    // Process in batches for concurrency control
    for (let i = 0; i < paragraphs.length; i += maxConcurrency) {
      if (signal?.aborted) {
        throw new TranslationError(
          'Translation was cancelled.',
          TranslationErrorCode.CANCELLED
        );
      }

      const batch = paragraphs.slice(i, i + maxConcurrency);
      const batchPromises = batch.map(async (paragraph, batchIndex) => {
        const globalIndex = i + batchIndex;
        const result = await this.translate(paragraph, { signal, glossary: options?.glossary });
        onParagraphProgress?.(globalIndex + 1, paragraphs.length);
        return { index: globalIndex, result };
      });

      const batchResults = await Promise.all(batchPromises);
      for (const { index, result } of batchResults) {
        results[index] = result;
      }
    }

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
