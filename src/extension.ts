import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigManager } from './config/manager';
import { FileSystemManager } from './fs/manager';
import { TranslationEngine } from './engine/translator';
import { PreviewMode, TranslationError, TranslationErrorCode, TranslationProgress } from './types';

let configManager: ConfigManager;
let fsManager: FileSystemManager | null = null;
let statusBarItem: vscode.StatusBarItem;
let currentTranslationController: AbortController | null = null;

function getOrCreateFsManager(workspaceRoot: string): FileSystemManager {
  if (!fsManager) {
    fsManager = new FileSystemManager(workspaceRoot);
  }
  return fsManager;
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
        await vscode.commands.executeCommand(
          'markdown.showPreview',
          uri,
          vscode.ViewColumn.Three
        );
        break;
      }
    }
  } catch (error) {
    console.error('Preview mode failed, falling back to editor:', error);
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
        vscode.window.showErrorMessage(
          'Authentication failed. Please check your API key.',
          'Set API Key'
        ).then(action => {
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
        vscode.window.showErrorMessage(
          'Network error. Please check your internet connection.'
        );
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
  console.error('Translation error:', error);
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Rosetta Mark extension is now active');

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

  // Set API Key command
  const setApiKeyCommand = vscode.commands.registerCommand(
    'rosettaMark.setApiKey',
    async () => {
      const scope = await vscode.window.showQuickPick(
        [
          {
            label: 'Global (User)',
            value: 'global' as const,
            description: 'For all projects (recommended)',
            picked: true
          },
          {
            label: 'Workspace',
            value: 'workspace' as const,
            description: 'Only for this project'
          }
        ],
        { placeHolder: 'Where should the API key be stored?' }
      );

      if (!scope) return;

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
          vscode.window.showInformationMessage(`API Key validated and saved to ${scope.label} scope!`);
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
    }
  );

  // Cancel translation command
  const cancelTranslationCommand = vscode.commands.registerCommand(
    'rosettaMark.cancelTranslation',
    () => {
      if (currentTranslationController) {
        currentTranslationController.abort();
        currentTranslationController = null;
        showIdleStatus();
      }
    }
  );

  // Translate command
  const translateCommand = vscode.commands.registerCommand(
    'rosettaMark.translate',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
      }

      if (editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Current file is not a Markdown file');
        return;
      }

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
      }

      const currentFsManager = getOrCreateFsManager(workspaceFolder.uri.fsPath);
      const sourcePath = editor.document.uri.fsPath;
      const content = editor.document.getText();

      try {
        // Check if translation is up to date
        const needsTranslation = await currentFsManager.needsTranslation(sourcePath, content);

        if (!needsTranslation) {
          const translationPath = currentFsManager.getTranslationPath(sourcePath);
          const config = vscode.workspace.getConfiguration('rosettaMark');
          const previewMode = config.get<PreviewMode>('previewMode', 'preview');

          await openTranslatedDocument(translationPath, previewMode);
          vscode.window.showInformationMessage('Translation is up to date!');
          return;
        }

        // Get existing translation for incremental update
        const existingMetadata = await currentFsManager.getParagraphMapping(
          currentFsManager.getTranslationPath(sourcePath)
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

        // Create abort controller for cancellation
        currentTranslationController = new AbortController();
        const signal = currentTranslationController.signal;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Translating markdown...',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              currentTranslationController?.abort();
            });

            const translationResult = await engine.translateWithExisting(
              content,
              existingMetadata?.paragraphs || [],
              {
                signal,
                onProgress: (p: TranslationProgress) => {
                  const percentage = Math.round((p.current / p.total) * 100);
                  updateStatusBar(
                    `$(sync~spin) Translating ${percentage}%`,
                    `${p.message}\nClick to cancel`,
                    'rosettaMark.cancelTranslation'
                  );
                  progress.report({
                    message: p.message,
                    increment: (100 / p.total),
                  });
                },
              }
            );

            progress.report({ message: 'Saving translation...' });

            const translationPath = await currentFsManager.saveTranslationWithMapping(
              sourcePath,
              content,
              translationResult.translatedText,
              translationResult.paragraphs,
              existingMetadata?.sourceLanguage
            );

            progress.report({ message: 'Opening translation...' });

            const vsConfig = vscode.workspace.getConfiguration('rosettaMark');
            const previewMode = vsConfig.get<PreviewMode>('previewMode', 'preview');

            await openTranslatedDocument(translationPath, previewMode);

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
        currentTranslationController = null;
        showIdleStatus();
      }
    }
  );

  // Batch translate command
  const batchTranslateCommand = vscode.commands.registerCommand(
    'rosettaMark.batchTranslate',
    async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      // Get files to translate
      let filesToTranslate: vscode.Uri[] = [];

      if (uris && uris.length > 0) {
        // Multiple files selected in explorer
        filesToTranslate = uris.filter(u => u.fsPath.endsWith('.md'));
      } else if (uri) {
        // Single file or folder
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          // Find all markdown files in directory
          const pattern = new vscode.RelativePattern(uri, '**/*.md');
          filesToTranslate = await vscode.workspace.findFiles(pattern);
        } else if (uri.fsPath.endsWith('.md')) {
          filesToTranslate = [uri];
        }
      } else {
        // No context - ask user
        const choice = await vscode.window.showQuickPick([
          { label: 'Current File', value: 'current' },
          { label: 'All Markdown Files in Workspace', value: 'workspace' },
        ], { placeHolder: 'What do you want to translate?' });

        if (!choice) return;

        if (choice.value === 'current') {
          const editor = vscode.window.activeTextEditor;
          if (editor && editor.document.languageId === 'markdown') {
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
      }

      const currentFsManager = getOrCreateFsManager(workspaceFolder.uri.fsPath);
      filesToTranslate = filesToTranslate.filter(f => !currentFsManager.isTranslationFile(f.fsPath));

      if (filesToTranslate.length === 0) {
        vscode.window.showInformationMessage('No source Markdown files found to translate');
        return;
      }

      const confirm = await vscode.window.showInformationMessage(
        `Translate ${filesToTranslate.length} file(s)?`,
        'Yes', 'No'
      );

      if (confirm !== 'Yes') return;

      currentTranslationController = new AbortController();
      const signal = currentTranslationController.signal;

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
              currentTranslationController?.abort();
            });

            const config = await configManager.getConfig();
            const engine = new TranslationEngine(config);

            for (let i = 0; i < filesToTranslate.length; i++) {
              if (signal.aborted) break;

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
                const content = await fs.readFile(fileUri.fsPath, 'utf-8');
                const needsTranslation = await currentFsManager.needsTranslation(fileUri.fsPath, content);

                if (!needsTranslation) {
                  successCount++;
                  continue;
                }

                const existingMetadata = await currentFsManager.getParagraphMapping(
                  currentFsManager.getTranslationPath(fileUri.fsPath)
                );

                const result = await engine.translateWithExisting(
                  content,
                  existingMetadata?.paragraphs || [],
                  { signal }
                );

                await currentFsManager.saveTranslationWithMapping(
                  fileUri.fsPath,
                  content,
                  result.translatedText,
                  result.paragraphs,
                  existingMetadata?.sourceLanguage
                );

                successCount++;
              } catch (error) {
                if (error instanceof TranslationError && error.code === TranslationErrorCode.CANCELLED) {
                  break;
                }
                console.error(`Error translating ${fileName}:`, error);
                errorCount++;
              }
            }
          }
        );
      } finally {
        currentTranslationController = null;
        showIdleStatus();
      }

      if (signal.aborted) {
        vscode.window.showInformationMessage(`Batch translation cancelled. Completed: ${successCount}, Errors: ${errorCount}`);
      } else {
        vscode.window.showInformationMessage(`Batch translation completed! Success: ${successCount}, Errors: ${errorCount}`);
      }
    }
  );

  // Reverse translate command
  const reverseTranslateCommand = vscode.commands.registerCommand(
    'rosettaMark.reverseTranslate',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
      }

      if (editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Current file is not a Markdown file');
        return;
      }

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
      }

      const currentFsManager = getOrCreateFsManager(workspaceFolder.uri.fsPath);
      const translationPath = editor.document.uri.fsPath;

      if (!currentFsManager.isTranslationFile(translationPath)) {
        vscode.window.showErrorMessage('This is not a translation file. Reverse translation can only be performed on files in the .rosetta-mark directory.');
        return;
      }

      try {
        const metadata = await currentFsManager.getParagraphMapping(translationPath);
        if (!metadata) {
          vscode.window.showErrorMessage('No translation metadata found. Please translate the original file first.');
          return;
        }

        const currentContent = editor.document.getText();
        const config = await configManager.getConfig();
        const engine = new TranslationEngine(config);

        let sourceLanguage = metadata.sourceLanguage;
        if (!sourceLanguage) {
          const sourcePath = currentFsManager.getSourcePathFromTranslation(translationPath);
          if (sourcePath) {
            try {
              const sourceContent = await fs.readFile(sourcePath, 'utf-8');
              const aiService = new (await import('./ai/service')).AIService(config);
              sourceLanguage = await aiService.detectLanguage(sourceContent);
            } catch {
              vscode.window.showErrorMessage('Could not detect source language. Please ensure the original file exists.');
              return;
            }
          }
        }

        if (!sourceLanguage) {
          vscode.window.showErrorMessage('Could not determine source language.');
          return;
        }

        currentTranslationController = new AbortController();
        const signal = currentTranslationController.signal;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Reverse translating...',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              currentTranslationController?.abort();
            });

            progress.report({ message: 'Detecting changes...' });

            // Add missing sourceHash to paragraphs for backward compatibility
            const paragraphsWithHash = metadata.paragraphs.map(p => ({
              ...p,
              sourceHash: p.sourceHash || '',
            }));

            const reverseResult = await engine.reverseTranslate(
              currentContent,
              paragraphsWithHash,
              sourceLanguage!,
              (message) => {
                updateStatusBar(
                  `$(sync~spin) Reverse translating...`,
                  message,
                  'rosettaMark.cancelTranslation'
                );
                progress.report({ message });
              },
              signal
            );

            if (reverseResult.modifiedIndices.length === 0) {
              vscode.window.showInformationMessage('No changes detected in the translation.');
              return;
            }

            progress.report({ message: 'Updating source file...' });

            const sourcePath = currentFsManager.getSourcePathFromTranslation(translationPath);
            if (!sourcePath) {
              vscode.window.showErrorMessage('Could not determine source file path.');
              return;
            }

            await fs.writeFile(sourcePath, reverseResult.newSourceContent, 'utf-8');

            await currentFsManager.updateParagraphMapping(
              translationPath,
              reverseResult.newParagraphs,
              reverseResult.newSourceContent
            );

            const sourceUri = vscode.Uri.file(sourcePath);
            const doc = await vscode.workspace.openTextDocument(sourceUri);
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Beside,
              preserveFocus: false,
            });

            vscode.window.showInformationMessage(
              `Reverse translation completed! Updated ${reverseResult.modifiedIndices.length} paragraph(s) in the source file.`
            );
          }
        );
      } catch (error) {
        handleTranslationError(error);
      } finally {
        currentTranslationController = null;
        showIdleStatus();
      }
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

      try {
        const config = await configManager.getConfig();
        const engine = new TranslationEngine(config);

        currentTranslationController = new AbortController();

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Translating selection...',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              currentTranslationController?.abort();
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
        currentTranslationController = null;
        showIdleStatus();
      }
    }
  );

  context.subscriptions.push(
    setApiKeyCommand,
    cancelTranslationCommand,
    translateCommand,
    batchTranslateCommand,
    reverseTranslateCommand,
    translateSelectionCommand
  );
}

export function deactivate() {
  if (currentTranslationController) {
    currentTranslationController.abort();
  }
  console.log('Rosetta Mark extension is now deactivated');
}
