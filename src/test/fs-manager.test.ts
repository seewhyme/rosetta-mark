import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileSystemManager } from '../fs/manager';

suite('FileSystemManager Test Suite', () => {
  let workspaceRoot: string;
  let storageRoot: string;
  let manager: FileSystemManager;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-mark-fs-'));
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-mark-storage-'));
    manager = new FileSystemManager(workspaceRoot, storageRoot);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  async function writeSource(relativePath: string, content: string): Promise<string> {
    const sourcePath = path.join(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content, 'utf8');
    return sourcePath;
  }

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

  test('should store translations under storage root instead of workspace root', () => {
    const sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');
    const translationPath = manager.getTranslationPath(sourcePath, 'zh-openai');

    assert.ok(
      translationPath.startsWith(storageRoot + path.sep),
      'translation path should be under VS Code storage root'
    );
    assert.ok(
      !translationPath.startsWith(path.join(workspaceRoot, '.rosetta-mark')),
      'translation path should not use project-local cache'
    );
  });

  test('should require translation when only a different config signature was cached', async () => {
    const sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');
    const content = '# Hello';

    await writeSource('docs/guide.md', content);

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

  test('should clean cache entries older than retention days', async () => {
    const now = Date.now();
    const sourcePath = await writeSource('docs/old.md', '# Hello');
    const translationPath = await manager.saveTranslationWithMapping(
      sourcePath,
      '# Hello',
      '# 你好',
      [],
      undefined,
      'zh-openai'
    );
    const metadataPath = path.join(manager.getTranslationDir(), 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const relativeTranslationPath = path.relative(manager.getTranslationDir(), translationPath);
    metadata.translations[relativeTranslationPath].lastAccessedAt = now - 31 * 24 * 60 * 60 * 1000;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    const result = await manager.cleanCache({
      retentionDays: 30,
      maxSizeMB: 0,
      now,
    });
    const exists = await fs
      .access(translationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(exists, false);
  });

  test('should keep entries when age cleanup is disabled', async () => {
    const now = Date.now();
    const sourcePath = await writeSource('docs/old-disabled.md', '# Hello');
    const translationPath = await manager.saveTranslationWithMapping(
      sourcePath,
      '# Hello',
      '# 你好',
      [],
      undefined,
      'zh-openai'
    );
    const metadataPath = path.join(manager.getTranslationDir(), 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const relativeTranslationPath = path.relative(manager.getTranslationDir(), translationPath);
    metadata.translations[relativeTranslationPath].lastAccessedAt = now - 365 * 24 * 60 * 60 * 1000;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    const result = await manager.cleanCache({
      retentionDays: 0,
      maxSizeMB: 0,
      now,
    });
    const exists = await fs
      .access(translationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(result.deletedFiles, 0);
    assert.strictEqual(exists, true);
  });

  test('should clean oldest entries when cache exceeds max size', async () => {
    const now = Date.now();
    const oldSourcePath = await writeSource('docs/old-size.md', '# Old');
    const newSourcePath = await writeSource('docs/new-size.md', '# New');

    const oldTranslationPath = await manager.saveTranslationWithMapping(
      oldSourcePath,
      '# Old',
      'x'.repeat(800),
      [],
      undefined,
      'zh-openai'
    );
    const newTranslationPath = await manager.saveTranslationWithMapping(
      newSourcePath,
      '# New',
      'y'.repeat(800),
      [],
      undefined,
      'zh-openai'
    );

    const metadataPath = path.join(manager.getTranslationDir(), 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    metadata.translations[
      path.relative(manager.getTranslationDir(), oldTranslationPath)
    ].lastAccessedAt = now - 1000;
    metadata.translations[
      path.relative(manager.getTranslationDir(), newTranslationPath)
    ].lastAccessedAt = now;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    const result = await manager.cleanCache({
      retentionDays: 0,
      maxSizeMB: 0.001,
      now,
    });
    const oldExists = await fs
      .access(oldTranslationPath)
      .then(() => true)
      .catch(() => false);
    const newExists = await fs
      .access(newTranslationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(oldExists, false);
    assert.strictEqual(newExists, true);
  });

  test('should delete entries whose source file no longer exists', async () => {
    const sourcePath = await writeSource('docs/deleted.md', '# Hello');
    const translationPath = await manager.saveTranslationWithMapping(
      sourcePath,
      '# Hello',
      '# 你好',
      [],
      undefined,
      'zh-openai'
    );

    await fs.rm(sourcePath);
    const result = await manager.cleanCache({
      retentionDays: 0,
      maxSizeMB: 0,
    });
    const exists = await fs
      .access(translationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(exists, false);
  });

  test('should clean legacy metadata cache files without translation index', async () => {
    const sourcePath = await writeSource('docs/legacy-metadata.md', '# Hello');
    const translationPath = manager.getTranslationPath(sourcePath, 'zh-openai');
    const metadataPath = path.join(manager.getTranslationDir(), 'metadata.json');

    await fs.mkdir(path.dirname(translationPath), { recursive: true });
    await fs.writeFile(translationPath, '# 你好', 'utf8');
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        'zh-openai:docs/legacy-metadata.md': 'placeholder',
      }),
      'utf8'
    );

    const result = await manager.cleanCache({
      retentionDays: 0,
      maxSizeMB: 0.000001,
    });
    const exists = await fs
      .access(translationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(exists, false);
  });

  test('should migrate legacy project cache when storage cache is empty', async () => {
    const sourcePath = await writeSource('docs/legacy.md', '# Hello');
    const legacyTranslationPath = path.join(
      workspaceRoot,
      '.rosetta-mark',
      'zh-openai',
      'docs',
      'legacy.md'
    );
    const legacyMetadataPath = path.join(workspaceRoot, '.rosetta-mark', 'metadata.json');
    await fs.mkdir(path.dirname(legacyTranslationPath), { recursive: true });
    await fs.writeFile(legacyTranslationPath, '# 你好', 'utf8');
    await fs.writeFile(
      legacyMetadataPath,
      JSON.stringify(
        {
          hashes: {
            'zh-openai:docs/legacy.md': 'placeholder',
          },
          translations: {
            [path.join('zh-openai', 'docs', 'legacy.md')]: {
              sourceHash: 'placeholder',
              sourcePath: path.relative(workspaceRoot, sourcePath),
              configSignature: 'zh-openai',
              paragraphs: [],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const migrated = await manager.migrateLegacyCacheIfNeeded();
    const newTranslationPath = manager.getTranslationPath(sourcePath, 'zh-openai');
    const content = await fs.readFile(newTranslationPath, 'utf8');
    const legacyStillExists = await fs
      .access(legacyTranslationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(migrated, true);
    assert.strictEqual(content, '# 你好');
    assert.strictEqual(legacyStillExists, true);
  });

  test('should not remigrate legacy cache after clearing workspace cache', async () => {
    const sourcePath = await writeSource('docs/legacy-clear.md', '# Hello');
    const legacyTranslationPath = path.join(
      workspaceRoot,
      '.rosetta-mark',
      'zh-openai',
      'docs',
      'legacy-clear.md'
    );
    await fs.mkdir(path.dirname(legacyTranslationPath), { recursive: true });
    await fs.writeFile(legacyTranslationPath, '# 你好', 'utf8');

    assert.strictEqual(await manager.migrateLegacyCacheIfNeeded(), true);
    await manager.clearCache();

    const remigrated = await manager.migrateLegacyCacheIfNeeded();
    const newTranslationPath = manager.getTranslationPath(sourcePath, 'zh-openai');
    const exists = await fs
      .access(newTranslationPath)
      .then(() => true)
      .catch(() => false);

    assert.strictEqual(remigrated, false);
    assert.strictEqual(exists, false);
  });
});
