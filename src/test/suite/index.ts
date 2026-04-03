import * as path from 'path';
import * as fs from 'fs/promises';
import Mocha from 'mocha';

async function collectTestFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTestFiles(entryPath);
    }

    return entry.name.endsWith('.test.js') ? [entryPath] : [];
  }));

  return files.flat();
}

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 10000,
  });

  const testsRoot = path.resolve(__dirname, '..');

  const files = await collectTestFiles(testsRoot);

  files.forEach(file => mocha.addFile(file));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}
