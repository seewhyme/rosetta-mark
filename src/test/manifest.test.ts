import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Extension Manifest Test Suite', () => {
  test('should not contribute reverse translate command or menus', () => {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const commands = packageJson.contributes?.commands ?? [];
    const editorTitleMenus = packageJson.contributes?.menus?.['editor/title'] ?? [];

    assert.ok(
      !commands.some((command: { command?: string }) => command.command === 'rosettaMark.reverseTranslate'),
      'reverse translate command should be removed from contributes.commands'
    );

    assert.ok(
      !editorTitleMenus.some((menu: { command?: string }) => menu.command === 'rosettaMark.reverseTranslate'),
      'reverse translate command should be removed from editor/title menu'
    );
  });
});
