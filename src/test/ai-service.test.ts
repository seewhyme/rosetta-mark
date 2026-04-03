import * as assert from 'assert';
import { AIService } from '../ai/service';
import { TranslationConfig, TranslationResult } from '../types';

suite('AIService Test Suite', () => {
  test('should batch short paragraphs into fewer model calls', async () => {
    const config: TranslationConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      targetLanguage: 'zh-CN',
    };

    const service = new AIService(config);
    const mutableService = service as AIService & {
      translate: (content: string) => Promise<TranslationResult>;
    };
    const paragraphs = ['One', 'Two', 'Three', 'Four'];
    let calls = 0;

    mutableService.translate = async (content: string): Promise<TranslationResult> => {
      calls++;
      const segmentMatches = [...content.matchAll(/<segment id="(\d+)">\n([\s\S]*?)\n<\/segment>/g)];
      if (segmentMatches.length > 0) {
        return {
          translatedText: segmentMatches
            .map(([, id, text]) => `<segment id="${id}">\nTRANSLATED:${text}\n</segment>`)
            .join('\n\n'),
        };
      }

      return { translatedText: `TRANSLATED:${content}` };
    };

    const results = await service.translateParagraphs(paragraphs, {
      maxConcurrency: 4,
      maxBatchTokens: 1000,
    });

    assert.deepStrictEqual(
      results.map((result: TranslationResult) => result.translatedText),
      ['TRANSLATED:One', 'TRANSLATED:Two', 'TRANSLATED:Three', 'TRANSLATED:Four']
    );
    assert.ok(calls < paragraphs.length, 'short paragraphs should be grouped into fewer model calls');
  });
});
