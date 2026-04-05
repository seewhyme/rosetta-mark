import * as assert from 'assert';
import { TranslationEngine } from '../engine/translator';
import { IncrementalTranslationResult, TranslationConfig, TranslationResult } from '../types';
import { AIService } from '../ai/service';

suite('TranslationEngine Test Suite', () => {
  test('should split batching groups at non-translatable segments', async () => {
    const config: TranslationConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      targetLanguage: 'zh-CN',
      maxConcurrency: 3,
    };

    const engine = new TranslationEngine(config);
    const aiService = (engine as unknown as { aiService: AIService }).aiService as AIService & {
      translateParagraphs: (paragraphs: string[]) => Promise<TranslationResult[]>;
    };

    const calls: string[][] = [];
    aiService.translateParagraphs = async (paragraphs: string[]): Promise<TranslationResult[]> => {
      calls.push(paragraphs);
      return paragraphs.map(paragraph => ({
        translatedText: `ZH:${paragraph}`,
      }));
    };

    const content = [
      '---',
      'title: Demo',
      '---',
      '',
      'Intro paragraph',
      '',
      '```ts',
      'console.log("hello")',
      '```',
      '',
      'After code block',
    ].join('\n');

    const result = await engine.translateIncremental(content) as IncrementalTranslationResult;

    assert.deepStrictEqual(calls, [['Intro paragraph'], ['After code block']]);
    assert.ok(result.translatedText.includes('ZH:Intro paragraph'));
    assert.ok(result.translatedText.includes('```ts'));
    assert.ok(result.translatedText.includes('ZH:After code block'));
  });
});
