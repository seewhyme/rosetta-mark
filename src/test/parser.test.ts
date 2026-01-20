import * as assert from 'assert';
import { MarkdownParser } from '../engine/parser';

suite('MarkdownParser Test Suite', () => {
  let parser: MarkdownParser;

  setup(() => {
    parser = new MarkdownParser();
  });

  suite('splitIntoParagraphs', () => {
    test('should split content by empty lines', () => {
      const content = 'First paragraph\n\nSecond paragraph\n\nThird paragraph';
      const result = parser.splitIntoParagraphs(content);

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0], 'First paragraph');
      assert.strictEqual(result[1], 'Second paragraph');
      assert.strictEqual(result[2], 'Third paragraph');
    });

    test('should handle multiple empty lines', () => {
      const content = 'First\n\n\n\nSecond';
      const result = parser.splitIntoParagraphs(content);

      assert.strictEqual(result.length, 2);
    });

    test('should filter empty paragraphs', () => {
      const content = '\n\nFirst\n\n\n\n';
      const result = parser.splitIntoParagraphs(content);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], 'First');
    });
  });

  suite('splitIntoParagraphsWithHash', () => {
    test('should identify code blocks', () => {
      const content = 'Text before\n\n```javascript\nconsole.log("hello");\n```\n\nText after';
      const result = parser.splitIntoParagraphsWithHash(content);

      const codeBlock = result.find(p => p.type === 'code');
      assert.ok(codeBlock, 'Should find a code block');
      assert.ok(codeBlock.content.includes('console.log'), 'Code block should contain the code');
    });

    test('should calculate hash for each paragraph', () => {
      const content = 'First paragraph\n\nSecond paragraph';
      const result = parser.splitIntoParagraphsWithHash(content);

      assert.ok(result[0].hash, 'First paragraph should have a hash');
      assert.ok(result[1].hash, 'Second paragraph should have a hash');
      assert.notStrictEqual(result[0].hash, result[1].hash, 'Different paragraphs should have different hashes');
    });

    test('should have same hash for identical content', () => {
      const content1 = 'Same content';
      const content2 = 'Same content';

      const hash1 = parser.calculateHash(content1);
      const hash2 = parser.calculateHash(content2);

      assert.strictEqual(hash1, hash2);
    });
  });

  suite('extractTextForTranslation', () => {
    test('should extract frontmatter', () => {
      const content = '---\ntitle: Test\n---\n\nContent here';
      const result = parser.extractTextForTranslation(content);

      assert.ok(result.frontmatter, 'Should extract frontmatter');
      assert.ok(result.frontmatter!.includes('title: Test'), 'Frontmatter should contain title');
    });

    test('should replace code blocks with placeholders', () => {
      const content = 'Text before\n\n```js\ncode\n```\n\nText after';
      const result = parser.extractTextForTranslation(content);

      assert.ok(result.translatableText.includes('__CODE_BLOCK_'), 'Should have code block placeholder');
      assert.ok(result.codeBlocks.size > 0, 'Should store code blocks');
    });

    test('should replace inline code with placeholders', () => {
      const content = 'Use `npm install` to install';
      const result = parser.extractTextForTranslation(content);

      assert.ok(result.translatableText.includes('__INLINE_CODE_'), 'Should have inline code placeholder');
    });
  });

  suite('restoreCodeBlocks', () => {
    test('should restore code blocks from placeholders', () => {
      const original = 'Text before\n\n```js\ncode\n```\n\nText after';
      const extracted = parser.extractTextForTranslation(original);

      // Simulate translation (just use the translatable text)
      const translated = extracted.translatableText;
      const restored = parser.restoreCodeBlocks(translated, extracted);

      assert.ok(restored.includes('```js'), 'Should restore code block');
      assert.ok(restored.includes('code'), 'Should restore code content');
    });

    test('should restore frontmatter', () => {
      const original = '---\ntitle: Test\n---\n\nContent';
      const extracted = parser.extractTextForTranslation(original);

      const translated = extracted.translatableText;
      const restored = parser.restoreCodeBlocks(translated, extracted);

      assert.ok(restored.startsWith('---'), 'Should start with frontmatter');
      assert.ok(restored.includes('title: Test'), 'Should restore frontmatter content');
    });
  });

  suite('joinParagraphs', () => {
    test('should join paragraphs with double newlines', () => {
      const paragraphs = ['First', 'Second', 'Third'];
      const result = parser.joinParagraphs(paragraphs);

      assert.strictEqual(result, 'First\n\nSecond\n\nThird');
    });
  });

  suite('estimateTokens', () => {
    test('should estimate token count', () => {
      const content = 'Hello world';  // 11 characters
      const tokens = parser.estimateTokens(content);

      assert.ok(tokens > 0, 'Should return positive token count');
      assert.ok(tokens <= content.length, 'Token count should be less than or equal to character count');
    });
  });

  suite('isContentTooLarge', () => {
    test('should return false for small content', () => {
      const content = 'Small content';
      assert.strictEqual(parser.isContentTooLarge(content), false);
    });

    test('should return true for large content with low limit', () => {
      const content = 'Some content here';
      assert.strictEqual(parser.isContentTooLarge(content, 1), true);
    });
  });

  suite('chunkContent', () => {
    test('should return single chunk for small content', () => {
      const content = 'Small paragraph';
      const chunks = parser.chunkContent(content, 1000);

      assert.strictEqual(chunks.length, 1);
    });

    test('should split into multiple chunks for large content', () => {
      const paragraphs = Array(10).fill('This is a test paragraph with some content.').join('\n\n');
      const chunks = parser.chunkContent(paragraphs, 50);

      assert.ok(chunks.length > 1, 'Should have multiple chunks');
    });
  });
});
