import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import * as crypto from 'crypto';

export interface ParsedParagraph {
  content: string;
  type: 'text' | 'code' | 'frontmatter';
  hash: string;
  startLine: number;
  endLine: number;
}

export interface ExtractedContent {
  translatableText: string;
  codeBlocks: Map<string, string>;
  frontmatter: string | null;
}

export class MarkdownParser {
  async parse(content: string): Promise<string> {
    const processor = unified()
      .use(remarkParse)
      .use(remarkFrontmatter, ['yaml', 'toml'])
      .use(remarkStringify, {
        bullet: '-',
        fence: '`',
        fences: true,
        incrementListMarker: false,
      });

    const ast = processor.parse(content);
    return processor.stringify(ast);
  }

  /**
   * 提取需要翻译的文本，跳过代码块
   * 返回处理后的文本，代码块用占位符替换
   */
  extractTextForTranslation(content: string): ExtractedContent {
    const codeBlocks = new Map<string, string>();
    let frontmatter: string | null = null;
    let placeholderIndex = 0;

    // 提取 frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch) {
      frontmatter = frontmatterMatch[0];
      content = content.slice(frontmatterMatch[0].length);
    }

    // 提取代码块并替换为占位符
    let translatableText = content.replace(
      /```[\s\S]*?```/g,
      (match) => {
        const placeholder = `__CODE_BLOCK_${placeholderIndex}__`;
        codeBlocks.set(placeholder, match);
        placeholderIndex++;
        return placeholder;
      }
    );

    // 提取行内代码并替换为占位符
    translatableText = translatableText.replace(
      /`[^`\n]+`/g,
      (match) => {
        const placeholder = `__INLINE_CODE_${placeholderIndex}__`;
        codeBlocks.set(placeholder, match);
        placeholderIndex++;
        return placeholder;
      }
    );

    return {
      translatableText,
      codeBlocks,
      frontmatter,
    };
  }

  /**
   * 还原翻译后的文本，将占位符替换回代码块
   */
  restoreCodeBlocks(translatedText: string, extracted: ExtractedContent): string {
    let result = translatedText;

    // 还原代码块
    for (const [placeholder, code] of extracted.codeBlocks) {
      result = result.replace(placeholder, code);
    }

    // 还原 frontmatter
    if (extracted.frontmatter) {
      result = extracted.frontmatter + result;
    }

    return result;
  }

  /**
   * 将 Markdown 内容按段落拆分
   * 段落以空行（两个连续换行符）分隔
   */
  splitIntoParagraphs(content: string): string[] {
    // 使用两个或更多连续换行符作为分隔符
    const paragraphs = content.split(/\n\n+/);
    // 过滤掉空段落
    return paragraphs.filter(p => p.trim().length > 0);
  }

  /**
   * 智能分割成段落，并计算每个段落的 hash
   */
  splitIntoParagraphsWithHash(content: string): ParsedParagraph[] {
    const lines = content.split('\n');
    const paragraphs: ParsedParagraph[] = [];
    let currentParagraph: string[] = [];
    let startLine = 0;
    let inCodeBlock = false;
    let codeBlockStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // 检测代码块开始/结束
      if (trimmedLine.startsWith('```')) {
        if (!inCodeBlock) {
          // 保存之前的段落
          if (currentParagraph.length > 0) {
            const content = currentParagraph.join('\n');
            paragraphs.push({
              content,
              type: 'text',
              hash: this.calculateHash(content),
              startLine,
              endLine: i - 1,
            });
            currentParagraph = [];
          }
          inCodeBlock = true;
          codeBlockStart = i;
        } else {
          // 代码块结束
          currentParagraph.push(line);
          const content = currentParagraph.join('\n');
          paragraphs.push({
            content,
            type: 'code',
            hash: this.calculateHash(content),
            startLine: codeBlockStart,
            endLine: i,
          });
          currentParagraph = [];
          inCodeBlock = false;
          startLine = i + 1;
          continue;
        }
      }

      if (inCodeBlock) {
        if (currentParagraph.length === 0) {
          currentParagraph.push(lines[codeBlockStart]);
        }
        if (i !== codeBlockStart) {
          currentParagraph.push(line);
        }
        continue;
      }

      // 检测空行（段落分隔符）
      if (trimmedLine === '') {
        if (currentParagraph.length > 0) {
          const content = currentParagraph.join('\n');
          paragraphs.push({
            content,
            type: 'text',
            hash: this.calculateHash(content),
            startLine,
            endLine: i - 1,
          });
          currentParagraph = [];
        }
        startLine = i + 1;
        continue;
      }

      // 正常行
      if (currentParagraph.length === 0) {
        startLine = i;
      }
      currentParagraph.push(line);
    }

    // 处理最后一个段落
    if (currentParagraph.length > 0) {
      const content = currentParagraph.join('\n');
      paragraphs.push({
        content,
        type: inCodeBlock ? 'code' : 'text',
        hash: this.calculateHash(content),
        startLine,
        endLine: lines.length - 1,
      });
    }

    return paragraphs;
  }

  /**
   * 将段落数组合并为 Markdown 内容
   */
  joinParagraphs(paragraphs: string[]): string {
    return paragraphs.join('\n\n');
  }

  /**
   * 合并 ParsedParagraph 数组
   */
  joinParsedParagraphs(paragraphs: ParsedParagraph[]): string {
    return paragraphs.map(p => p.content).join('\n\n');
  }

  /**
   * 计算内容的 hash
   */
  calculateHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * 估算文本的 token 数量（简单估算）
   * 大约每 4 个字符算 1 个 token
   */
  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /**
   * 检查内容是否超过大小限制
   */
  isContentTooLarge(content: string, maxTokens: number = 100000): boolean {
    return this.estimateTokens(content) > maxTokens;
  }

  /**
   * 将大文档分块
   */
  chunkContent(content: string, maxTokensPerChunk: number = 4000): string[] {
    const paragraphs = this.splitIntoParagraphs(content);
    const chunks: string[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;

    for (const paragraph of paragraphs) {
      const paragraphTokens = this.estimateTokens(paragraph);

      if (paragraphTokens > maxTokensPerChunk) {
        // 段落本身太大，需要进一步分割
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n'));
          currentChunk = [];
          currentTokens = 0;
        }
        // 按句子分割大段落
        const sentences = paragraph.split(/(?<=[.!?。！？])\s+/);
        let sentenceChunk: string[] = [];
        let sentenceTokens = 0;

        for (const sentence of sentences) {
          const tokens = this.estimateTokens(sentence);
          if (sentenceTokens + tokens > maxTokensPerChunk) {
            if (sentenceChunk.length > 0) {
              chunks.push(sentenceChunk.join(' '));
              sentenceChunk = [];
              sentenceTokens = 0;
            }
          }
          sentenceChunk.push(sentence);
          sentenceTokens += tokens;
        }

        if (sentenceChunk.length > 0) {
          chunks.push(sentenceChunk.join(' '));
        }
        continue;
      }

      if (currentTokens + paragraphTokens > maxTokensPerChunk) {
        chunks.push(currentChunk.join('\n\n'));
        currentChunk = [];
        currentTokens = 0;
      }

      currentChunk.push(paragraph);
      currentTokens += paragraphTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));
    }

    return chunks;
  }
}
