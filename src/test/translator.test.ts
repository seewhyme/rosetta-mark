import * as assert from 'assert';
import { TranslationEngine } from '../engine/translator';
import { IncrementalTranslationResult, TranslationConfig, TranslationResult } from '../types';
import { AIService } from '../ai/service';

suite('TranslationEngine Test Suite', () => {
  test('should flatten translatable paragraphs into a single call and preserve original positions', async () => {
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

    const result = (await engine.translateIncremental(content)) as IncrementalTranslationResult;

    // Flattened: a single call with both translatable paragraphs (in original order).
    assert.strictEqual(calls.length, 1, 'should call translateParagraphs only once');
    assert.deepStrictEqual(calls[0], ['Intro paragraph', 'After code block']);

    // Result must preserve original positions: code block stays between the two translated paragraphs.
    assert.ok(result.translatedText.includes('ZH:Intro paragraph'));
    assert.ok(result.translatedText.includes('```ts'));
    assert.ok(result.translatedText.includes('ZH:After code block'));

    const introIdx = result.translatedText.indexOf('ZH:Intro paragraph');
    const codeIdx = result.translatedText.indexOf('```ts');
    const afterIdx = result.translatedText.indexOf('ZH:After code block');
    assert.ok(introIdx < codeIdx && codeIdx < afterIdx, 'order: intro → code → after');
  });
});
