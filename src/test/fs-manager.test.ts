import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileSystemManager } from '../fs/manager';

suite('FileSystemManager Test Suite', () => {
  let workspaceRoot: string;
  let manager: FileSystemManager;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-mark-fs-'));
    manager = new FileSystemManager(workspaceRoot);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test('should isolate translation paths by config signature', () => {
    const sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');

    const zhPath = manager.getTranslationPath(sourcePath, 'zh-openai');
    const jaPath = manager.getTranslationPath(sourcePath, 'ja-openai');

    assert.notStrictEqual(
      zhPath,
      jaPath,
      'different translation signatures should produce different translation file paths'
    );
  });

  test('should require translation when only a different config signature was cached', async () => {
    const sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');
    const content = '# Hello';

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content, 'utf8');

    await manager.saveTranslationWithMapping(
      sourcePath,
      content,
      '# 你好',
      [],
      undefined,
      'zh-openai'
    );

    const needsTranslation = await manager.needsTranslation(sourcePath, content, 'ja-openai');

    assert.strictEqual(
      needsTranslation,
      true,
      'cache from a different translation signature must not be reused'
    );
  });
});
