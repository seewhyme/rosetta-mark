import * as vscode from 'vscode';
import { TranslationError, TranslationErrorCode } from '../types';

export class ErrorHandler {
  /**
   * Display user-friendly error messages and provide actionable suggestions
   */
  static async handleError(error: unknown, context?: string): Promise<void> {
    const translationError = error instanceof TranslationError
      ? error
      : this.createTranslationError(error);

    const errorMessage = this.getErrorMessage(translationError, context);
    const actions = this.getErrorActions(translationError);

    if (actions.length > 0) {
      const choice = await vscode.window.showErrorMessage(
        errorMessage,
        ...actions.map(a => a.label)
      );

      if (choice) {
        const action = actions.find(a => a.label === choice);
        await action?.handler();
      }
    } else {
      vscode.window.showErrorMessage(errorMessage);
    }

    // Log detailed error for debugging
    console.error(`[Rosetta Mark] Error: ${translationError.message}`, translationError.cause);
  }

  private static createTranslationError(error: unknown): TranslationError {
    if (error instanceof TranslationError) {
      return error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes('rate limit') || lowerMessage.includes('429')) {
      return new TranslationError(
        'Rate limit exceeded. Please wait before retrying.',
        TranslationErrorCode.RATE_LIMIT,
        true
      );
    }

    if (lowerMessage.includes('unauthorized') || lowerMessage.includes('401')) {
      return new TranslationError(
        'Authentication failed. Please check your API key.',
        TranslationErrorCode.AUTH_ERROR,
        false
      );
    }

    if (lowerMessage.includes('network') || lowerMessage.includes('timeout')) {
      return new TranslationError(
        'Network error. Please check your connection.',
        TranslationErrorCode.NETWORK_ERROR,
        true
      );
    }

    return new TranslationError(
      errorMessage,
      TranslationErrorCode.UNKNOWN,
      false
    );
  }

  private static getErrorMessage(error: TranslationError, context?: string): string {
    const prefix = context ? `${context}: ` : '';

    switch (error.code) {
      case TranslationErrorCode.AUTH_ERROR:
        return `${prefix}Authentication failed. Your API key may be invalid or expired. Please verify your API key is correct for the selected provider.`;

      case TranslationErrorCode.RATE_LIMIT:
        return `${prefix}Rate limit exceeded. You've made too many requests. Please wait a few minutes before trying again, or reduce the maxConcurrency setting.`;

      case TranslationErrorCode.NETWORK_ERROR:
        return `${prefix}Network error. Please check your internet connection and try again. If using a custom baseUrl, verify it's correct.`;

      case TranslationErrorCode.CANCELLED:
        return `${prefix}Translation was cancelled.`;

      case TranslationErrorCode.FILE_TOO_LARGE:
        return `${prefix}File is too large to translate. Consider splitting it into smaller files or translating selected portions.`;

      case TranslationErrorCode.INVALID_RESPONSE:
        return `${prefix}Received invalid response from AI provider. Please try again or switch to a different provider.`;

      default:
        return `${prefix}${error.message}`;
    }
  }

  private static getErrorActions(error: TranslationError): Array<{ label: string; handler: () => Promise<void> }> {
    const actions: Array<{ label: string; handler: () => Promise<void> }> = [];

    switch (error.code) {
      case TranslationErrorCode.AUTH_ERROR:
        actions.push({
          label: 'Set API Key',
          handler: async () => {
            await vscode.commands.executeCommand('rosettaMark.setApiKey');
          }
        });
        actions.push({
          label: 'Open Settings',
          handler: async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'rosettaMark');
          }
        });
        break;

      case TranslationErrorCode.RATE_LIMIT:
        actions.push({
          label: 'Reduce Concurrency',
          handler: async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'rosettaMark.maxConcurrency');
          }
        });
        actions.push({
          label: 'Retry',
          handler: async () => {
            // User can manually retry
            vscode.window.showInformationMessage('Please wait a few minutes before retrying.');
          }
        });
        break;

      case TranslationErrorCode.NETWORK_ERROR:
        actions.push({
          label: 'Check Settings',
          handler: async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'rosettaMark.baseUrl');
          }
        });
        actions.push({
          label: 'Retry',
          handler: async () => {
            vscode.window.showInformationMessage('Please check your connection and retry the translation.');
          }
        });
        break;

      case TranslationErrorCode.FILE_TOO_LARGE:
        actions.push({
          label: 'Translate Selection',
          handler: async () => {
            vscode.window.showInformationMessage('Select a portion of the text and use "Translate Selection" instead.');
          }
        });
        break;
    }

    return actions;
  }

  /**
   * Validate API key format for different providers
   */
  static validateApiKeyFormat(apiKey: string, provider: string): { valid: boolean; message?: string } {
    if (!apiKey || apiKey.trim().length === 0) {
      return { valid: false, message: 'API key cannot be empty' };
    }

    switch (provider) {
      case 'openai':
        if (!apiKey.startsWith('sk-')) {
          return { valid: false, message: 'OpenAI API keys should start with "sk-"' };
        }
        if (apiKey.length < 20) {
          return { valid: false, message: 'OpenAI API key seems too short' };
        }
        break;

      case 'anthropic':
        if (!apiKey.startsWith('sk-ant-')) {
          return { valid: false, message: 'Anthropic API keys should start with "sk-ant-"' };
        }
        break;

      case 'google':
        if (apiKey.length < 20) {
          return { valid: false, message: 'Google API key seems too short' };
        }
        break;

      case 'openrouter':
        if (!apiKey.startsWith('sk-or-')) {
          return { valid: false, message: 'OpenRouter API keys should start with "sk-or-"' };
        }
        break;

      case 'ollama':
        // Ollama doesn't require a real API key
        break;
    }

    return { valid: true };
  }

  /**
   * Show progress notification with cancellation support
   */
  static showProgressWithCancellation(
    title: string,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<void>
  ): Thenable<void> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true
      },
      task
    );
  }
}
