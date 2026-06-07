import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigManager } from './config/manager';
import { CacheCleanupResult, FileSystemManager } from './fs/manager';
import { TranslationEngine } from './engine/translator';
import { PreviewMode, TranslationError, TranslationErrorCode, TranslationProgress } from './types';
import * as logger from './logger';

let configManager: ConfigManager;
let extensionContext: vscode.ExtensionContext;
const fsManagers = new Map<string, FileSystemManager>();
let statusBarItem: vscode.StatusBarItem;
const activeControllers = new Set<AbortController>();

function getStorageRoot(context: vscode.ExtensionContext): string {
  if (context.storageUri) {
    return context.storageUri.fsPath;
  }
  return path.join(context.globalStorageUri.fsPath, 'workspace-fallback');
}

function getOrCreateFsManager(workspaceRoot: string): FileSystemManager {
  const storageRoot = getStorageRoot(extensionContext);
  const managerKey = `${workspaceRoot}:${storageRoot}`;
  let manager = fsManagers.get(managerKey);

  if (!manager) {
    manager = new FileSystemManager(workspaceRoot, storageRoot);
    fsManagers.set(managerKey, manager);
  }

  return manager;
}

async function prepareFsManager(workspaceRoot: string): Promise<FileSystemManager> {
  const manager = getOrCreateFsManager(workspaceRoot);

  try {
    await manager.migrateLegacyCacheIfNeeded();
  } catch (error) {
    logger.warn('Failed to migrate legacy translation cache');
  }

  return manager;
}

async function getFsManagerForUri(uri: vscode.Uri): Promise<FileSystemManager | null> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return null;
  }

  return prepareFsManager(workspaceFolder.uri.fsPath);
}

function getCacheCleanupSettings(): {
  retentionDays: number;
  maxSizeMB: number;
} {
  const settings = configManager.getCacheSettings();
  return {
    retentionDays: Math.max(0, settings.retentionDays),
    maxSizeMB: Math.max(0, settings.maxSizeMB),
  };
}

async function cleanCacheQuietly(
  manager: FileSystemManager,
  protectedPaths: string[] = []
): Promise<CacheCleanupResult | null> {
  try {
    return await manager.cleanCache({
      ...getCacheCleanupSettings(),
      protectedPaths,
    });
  } catch (error) {
    logger.warn('Failed to clean translation cache');
    return null;
  }
}

async function runStartupCacheMaintenance(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  for (const workspaceFolder of workspaceFolders) {
    const manager = await prepareFsManager(workspaceFolder.uri.fsPath);
    await cleanCacheQuietly(manager);
  }
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (activeWorkspace) {
      return activeWorkspace;
    }
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length <= 1) {
    return workspaceFolders[0];
  }

  const choice = await vscode.window.showQuickPick(
    workspaceFolders.map(folder => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { placeHolder: 'Select workspace cache to clean' }
  );

  return choice?.folder;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function isMarkdownUri(uri: vscode.Uri): boolean {
  return path.extname(uri.fsPath).toLowerCase() === '.md';
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'markdown' || isMarkdownUri(document.uri);
}

function updateStatusBar(text: string, tooltip?: string, command?: string): void {
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
  statusBarItem.command = command;
  statusBarItem.show();
}

function showIdleStatus(): void {
  const config = vscode.workspace.getConfiguration('rosettaMark');
  const provider = config.get<string>('provider', 'openai');
  const model = config.get<string>('model', 'gpt-4o-mini');
  updateStatusBar(
    `$(globe) ${provider}/${model}`,
    `Rosetta Mark: ${provider} - ${model}\nClick to translate current file`,
    'rosettaMark.translate'
  );
}

async function openTranslatedDocument(
  translationPath: string,
  previewMode: PreviewMode
): Promise<void> {
  const uri = vscode.Uri.file(translationPath);

  try {
    switch (previewMode) {
      case 'editor': {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: false,
        });
        break;
      }

      case 'preview': {
        // Open the translated file in editor beside the source
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: false,
        });
        break;
      }

      case 'both': {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: true,
        });

        await new Promise(resolve => setTimeout(resolve, 100));
        await vscode.commands.executeCommand('markdown.showPreview', uri, vscode.ViewColumn.Three);
        break;
      }
    }
  } catch (error) {
    logger.error('Preview mode failed, falling back to editor', error);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    });
  }
}

function handleTranslationError(error: unknown): void {
  if (error instanceof TranslationError) {
    switch (error.code) {
      case TranslationErrorCode.CANCELLED:
        vscode.window.showInformationMessage('Translation was cancelled.');
        break;
      case TranslationErrorCode.AUTH_ERROR:
        vscode.window
          .showErrorMessage('Authentication failed. Please check your API key.', 'Set API Key')
          .then(action => {
            if (action === 'Set API Key') {
              vscode.commands.executeCommand('rosettaMark.setApiKey');
            }
          });
        break;
      case TranslationErrorCode.RATE_LIMIT:
        vscode.window.showWarningMessage(
          'Rate limit exceeded. Please wait a moment and try again.'
        );
        break;
      case TranslationErrorCode.NETWORK_ERROR:
        vscode.window.showErrorMessage('Network error. Please check your internet connection.');
        break;
      case TranslationErrorCode.FILE_TOO_LARGE:
        vscode.window.showErrorMessage(error.message);
        break;
      default:
        vscode.window.showErrorMessage(`Translation failed: ${error.message}`);
    }
  } else {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Translation failed: ${errorMessage}`);
  }
  logger.error('Translation error', error);
}

export function activate(context: vscode.ExtensionContext) {
  logger.initLogger(context);
  logger.log('Rosetta Mark extension is now active');

  extensionContext = context;
  configManager = new ConfigManager(context);

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);
  showIdleStatus();

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('rosettaMark')) {
        showIdleStatus();
      }
    })
  );

  void runStartupCacheMaintenance();

  // Set API Key command
  const setApiKeyCommand = vscode.commands.registerCommand('rosettaMark.setApiKey', async () => {
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: 'Global (User)',
          value: 'global' as const,
          description: 'For all projects (recommended)',
          picked: true,
        },
        {
          label: 'Workspace',
          value: 'workspace' as const,
          description: 'Only for this project',
        },
      ],
      { placeHolder: 'Where should the API key be stored?' }
    );

    if (!scope) {
      return;
    }

    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter your API Key (${scope.label})`,
      password: true,
      placeHolder: 'sk-...',
    });

    if (apiKey) {
      // Validate API key before saving
      updateStatusBar('$(sync~spin) Validating API key...', 'Validating API key');

      try {
        const config = await configManager.getConfigWithApiKey(apiKey);
        const engine = new TranslationEngine(config);
        const isValid = await engine.validateApiKey();

        if (!isValid) {
          vscode.window.showErrorMessage('Invalid API key. Please check and try again.');
          showIdleStatus();
          return;
        }

        await configManager.setApiKey(apiKey, scope.value);
        vscode.window.showInformationMessage(
          `API Key validated and saved to ${scope.label} scope!`
        );
      } catch (error) {
        if (error instanceof TranslationError && error.code === TranslationErrorCode.AUTH_ERROR) {
          vscode.window.showErrorMessage('Invalid API key. Please check and try again.');
        } else {
          // Network error or other - save anyway
          await configManager.setApiKey(apiKey, scope.value);
          vscode.window.showInformationMessage(
            `API Key saved to ${scope.label} scope. (Could not validate due to network issues)`
          );
        }
      }

      showIdleStatus();
    }
  });

  // Cancel translation command
  const cancelTranslationCommand = vscode.commands.registerCommand(
    'rosettaMark.cancelTranslation',
    () => {
      for (const controller of activeControllers) {
        controller.abort();
      }
      activeControllers.clear();
      showIdleStatus();
    }
  );

  // Translate command
  const translateCommand = vscode.commands.registerCommand('rosettaMark.translate', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    if (!isMarkdownDocument(editor.document)) {
      vscode.window.showErrorMessage('Current file is not a Markdown file');
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('Please open a workspace folder first');
      return;
    }

    const currentFsManager = await prepareFsManager(workspaceFolder.uri.fsPath);
    const sourcePath = editor.document.uri.fsPath;
    const content = editor.document.getText();
    const configSignature = configManager.getConfigSignature();
    const controller = new AbortController();
    activeControllers.add(controller);

    try {
      // Check if translation is up to date
      const needsTranslation = await currentFsManager.needsTranslation(
        sourcePath,
        content,
        configSignature
      );

      if (!needsTranslation) {
        const translationPath = currentFsManager.getTranslationPath(sourcePath, configSignature);
        const config = vscode.workspace.getConfiguration('rosettaMark');
        const previewMode = config.get<PreviewMode>('previewMode', 'preview');

        await openTranslatedDocument(translationPath, previewMode);
        await currentFsManager.getExistingTranslation(sourcePath, configSignature);
        vscode.window.showInformationMessage('Translation is up to date!');
        return;
      }

      // Get existing translation for incremental update
      const existingMetadata = await currentFsManager.getParagraphMapping(
        currentFsManager.getTranslationPath(sourcePath, configSignature)
      );

      const config = await configManager.getConfig();
      const engine = new TranslationEngine(config);

      // Check document size
      const sizeCheck = engine.checkDocumentSize(content);
      if (!sizeCheck.valid) {
        throw new TranslationError(
          sizeCheck.message || 'Document is too large',
          TranslationErrorCode.FILE_TOO_LARGE
        );
      }

      const signal = controller.signal;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Translating markdown...',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            controller.abort();
          });

          let lastReportedPercent = 0;
          const translationResult = await engine.translateWithExisting(
            content,
            existingMetadata?.paragraphs || [],
            {
              signal,
              onProgress: (p: TranslationProgress) => {
                const newPercent = Math.round((p.current / p.total) * 100);
                updateStatusBar(
                  `$(sync~spin) Translating ${newPercent}%`,
                  `${p.message}\nClick to cancel`,
                  'rosettaMark.cancelTranslation'
                );
                const increment = newPercent - lastReportedPercent;
                lastReportedPercent = newPercent;
                if (increment > 0) {
                  progress.report({
                    message: p.message,
                    increment,
                  });
                }
              },
            }
          );

          progress.report({ message: 'Saving translation...' });

          const translationPath = await currentFsManager.saveTranslationWithMapping(
            sourcePath,
            content,
            translationResult.translatedText,
            translationResult.paragraphs,
            existingMetadata?.sourceLanguage,
            configSignature
          );

          progress.report({ message: 'Opening translation...' });

          const vsConfig = vscode.workspace.getConfiguration('rosettaMark');
          const previewMode = vsConfig.get<PreviewMode>('previewMode', 'preview');

          await openTranslatedDocument(translationPath, previewMode);
          await cleanCacheQuietly(currentFsManager, [translationPath]);

          let message = 'Translation completed!';
          if (translationResult.reusedParagraphs > 0) {
            message += ` (Reused ${translationResult.reusedParagraphs} cached paragraphs)`;
          }
          if (translationResult.tokenUsage) {
            message += ` Tokens: ${translationResult.tokenUsage.total}`;
          }

          vscode.window.showInformationMessage(message);
        }
      );
    } catch (error) {
      handleTranslationError(error);
    } finally {
      activeControllers.delete(controller);
      showIdleStatus();
    }
  });

  // Batch translate command
  const batchTranslateCommand = vscode.commands.registerCommand(
    'rosettaMark.batchTranslate',
    async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      // Get files to translate
      let filesToTranslate: vscode.Uri[] = [];

      if (uris && uris.length > 0) {
        // Multiple files selected in explorer
        filesToTranslate = uris.filter(isMarkdownUri);
      } else if (uri) {
        // Single file or folder
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          // Find all markdown files in directory
          const pattern = new vscode.RelativePattern(uri, '**/*.md');
          filesToTranslate = await vscode.workspace.findFiles(pattern);
        } else if (isMarkdownUri(uri)) {
          filesToTranslate = [uri];
        }
      } else {
        // No context - ask user
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Current File', value: 'current' },
            { label: 'All Markdown Files in Workspace', value: 'workspace' },
          ],
          { placeHolder: 'What do you want to translate?' }
        );

        if (!choice) {
          return;
        }

        if (choice.value === 'current') {
          const editor = vscode.window.activeTextEditor;
          if (editor && isMarkdownDocument(editor.document)) {
            filesToTranslate = [editor.document.uri];
          } else {
            vscode.window.showErrorMessage('No Markdown file is currently open');
            return;
          }
        } else {
          filesToTranslate = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
        }
      }

      if (filesToTranslate.length === 0) {
        vscode.window.showInformationMessage('No Markdown files found to translate');
        return;
      }

      // Filter out translation files
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
      }

      const sourceFiles: vscode.Uri[] = [];
      for (const file of filesToTranslate) {
        const fileFsManager = await getFsManagerForUri(file);
        if (fileFsManager && !fileFsManager.isTranslationFile(file.fsPath)) {
          sourceFiles.push(file);
        }
      }
      filesToTranslate = sourceFiles;

      if (filesToTranslate.length === 0) {
        vscode.window.showInformationMessage('No source Markdown files found to translate');
        return;
      }

      const confirm = await vscode.window.showInformationMessage(
        `Translate ${filesToTranslate.length} file(s)?`,
        'Yes',
        'No'
      );

      if (confirm !== 'Yes') {
        return;
      }

      const batchController = new AbortController();
      activeControllers.add(batchController);
      const signal = batchController.signal;

      let successCount = 0;
      let errorCount = 0;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Batch translating...',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              batchController.abort();
            });

            const config = await configManager.getConfig();
            const engine = new TranslationEngine(config);

            for (let i = 0; i < filesToTranslate.length; i++) {
              if (signal.aborted) {
                break;
              }

              const fileUri = filesToTranslate[i];
              const fileName = path.basename(fileUri.fsPath);

              progress.report({
                message: `[${i + 1}/${filesToTranslate.length}] ${fileName}`,
                increment: 100 / filesToTranslate.length,
              });

              updateStatusBar(
                `$(sync~spin) Batch: ${i + 1}/${filesToTranslate.length}`,
                `Translating ${fileName}\nClick to cancel`,
                'rosettaMark.cancelTranslation'
              );

              try {
                const fileFsManager = await getFsManagerForUri(fileUri);
                if (!fileFsManager) {
                  errorCount++;
                  continue;
                }

                const content = await fs.readFile(fileUri.fsPath, 'utf-8');
                const configSignature = configManager.getConfigSignature();
                const needsTranslation = await fileFsManager.needsTranslation(
                  fileUri.fsPath,
                  content,
                  configSignature
                );

                if (!needsTranslation) {
                  successCount++;
                  continue;
                }

                const existingMetadata = await fileFsManager.getParagraphMapping(
                  fileFsManager.getTranslationPath(fileUri.fsPath, configSignature)
                );

                const result = await engine.translateWithExisting(
                  content,
                  existingMetadata?.paragraphs || [],
                  { signal }
                );

                const translationPath = await fileFsManager.saveTranslationWithMapping(
                  fileUri.fsPath,
                  content,
                  result.translatedText,
                  result.paragraphs,
                  existingMetadata?.sourceLanguage,
                  configSignature
                );
                await cleanCacheQuietly(fileFsManager, [translationPath]);

                successCount++;
              } catch (error) {
                if (
                  error instanceof TranslationError &&
                  error.code === TranslationErrorCode.CANCELLED
                ) {
                  break;
                }
                logger.error(`Error translating ${fileName}`, error);
                errorCount++;
              }
            }
          }
        );
      } finally {
        activeControllers.delete(batchController);
        showIdleStatus();
      }

      if (signal.aborted) {
        vscode.window.showInformationMessage(
          `Batch translation cancelled. Completed: ${successCount}, Errors: ${errorCount}`
        );
      } else {
        vscode.window.showInformationMessage(
          `Batch translation completed! Success: ${successCount}, Errors: ${errorCount}`
        );
      }
    }
  );

  const cleanTranslationCacheCommand = vscode.commands.registerCommand(
    'rosettaMark.cleanTranslationCache',
    async () => {
      const workspaceFolder = await pickWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
      }

      const manager = await prepareFsManager(workspaceFolder.uri.fsPath);
      const action = await vscode.window.showQuickPick(
        [
          {
            label: 'Clean Expired Cache',
            description: 'Use current retention and size settings',
            value: 'configured' as const,
          },
          {
            label: 'Clear All Workspace Cache',
            description: 'Delete every cached translation for this workspace',
            value: 'all' as const,
          },
        ],
        { placeHolder: 'How should Rosetta Mark clean the translation cache?' }
      );

      if (!action) {
        return;
      }

      let result: CacheCleanupResult;

      if (action.value === 'all') {
        const confirm = await vscode.window.showWarningMessage(
          `Delete all cached translations for ${workspaceFolder.name}?`,
          { modal: true },
          'Delete'
        );

        if (confirm !== 'Delete') {
          return;
        }

        result = await manager.clearCache();
      } else {
        result = await manager.cleanCache(getCacheCleanupSettings());
      }

      vscode.window.showInformationMessage(
        `Translation cache cleaned. Deleted ${result.deletedFiles} file(s), freed ${formatBytes(
          result.deletedBytes
        )}, remaining ${formatBytes(result.remainingBytes)}.`
      );
    }
  );

  // Translate selection command
  const translateSelectionCommand = vscode.commands.registerCommand(
    'rosettaMark.translateSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showErrorMessage('No text selected');
        return;
      }

      const selectedText = editor.document.getText(selection);
      const selectionController = new AbortController();
      activeControllers.add(selectionController);

      try {
        const config = await configManager.getConfig();
        const engine = new TranslationEngine(config);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Translating selection...',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              selectionController.abort();
            });

            updateStatusBar(
              '$(sync~spin) Translating...',
              'Translating selection\nClick to cancel',
              'rosettaMark.cancelTranslation'
            );

            const result = await engine.translate(selectedText);

            // Replace selection with translation
            await editor.edit(editBuilder => {
              editBuilder.replace(selection, result.translatedText);
            });

            vscode.window.showInformationMessage('Selection translated!');
          }
        );
      } catch (error) {
        handleTranslationError(error);
      } finally {
        activeControllers.delete(selectionController);
        showIdleStatus();
      }
    }
  );

  context.subscriptions.push(
    setApiKeyCommand,
    cancelTranslationCommand,
    translateCommand,
    batchTranslateCommand,
    cleanTranslationCacheCommand,
    translateSelectionCommand
  );
}

export function deactivate() {
  for (const controller of activeControllers) {
    controller.abort();
  }
  activeControllers.clear();
}
