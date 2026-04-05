import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TranslationConfig, ProviderType, ConfigScope, GlossaryEntry } from '../types';

export class ConfigManager {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private getConfigValue<T>(
    config: vscode.WorkspaceConfiguration,
    key: string,
    defaultValue: T
  ): T {
    const inspection = config.inspect<T>(key);
    return inspection?.workspaceValue ?? inspection?.globalValue ?? defaultValue;
  }

  async getConfig(): Promise<TranslationConfig> {
    const { provider, model, baseUrl, targetLanguage, maxConcurrency, glossary } =
      this.getTranslationSettings();

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('API Key not set. Please run "Rosetta Mark: Set API Key" command first.');
    }

    return {
      provider,
      model,
      apiKey,
      baseUrl: baseUrl || undefined,
      targetLanguage,
      maxConcurrency,
      glossary: glossary.length > 0 ? glossary : undefined,
    };
  }

  async getConfigWithApiKey(apiKey: string): Promise<TranslationConfig> {
    const { provider, model, baseUrl, targetLanguage, maxConcurrency, glossary } =
      this.getTranslationSettings();

    return {
      provider,
      model,
      apiKey,
      baseUrl: baseUrl || undefined,
      targetLanguage,
      maxConcurrency,
      glossary: glossary.length > 0 ? glossary : undefined,
    };
  }

  getTranslationSettings(): {
    provider: ProviderType;
    model: string;
    baseUrl: string;
    targetLanguage: string;
    maxConcurrency: number;
    glossary: GlossaryEntry[];
  } {
    const config = vscode.workspace.getConfiguration('rosettaMark');
    const provider = this.getConfigValue<ProviderType>(config, 'provider', 'openai');
    const model = this.getConfigValue<string>(config, 'model', 'gpt-4o-mini');
    const baseUrl = this.getConfigValue<string>(config, 'baseUrl', '');
    const targetLanguage = this.getConfigValue<string>(config, 'targetLanguage', 'zh-CN');
    const maxConcurrency = this.getConfigValue<number>(config, 'maxConcurrency', 3);
    const glossary = this.getConfigValue<GlossaryEntry[]>(config, 'glossary', []);
    return {
      provider,
      model,
      baseUrl,
      targetLanguage,
      maxConcurrency,
      glossary,
    };
  }

  getConfigSignature(): string {
    const settings = this.getTranslationSettings();
    const normalizedGlossary = [...settings.glossary]
      .map(entry => ({
        source: entry.source,
        target: entry.target,
        caseSensitive: entry.caseSensitive ?? false,
      }))
      .sort((a, b) => {
        if (a.source !== b.source) {
          return a.source.localeCompare(b.source);
        }
        if (a.target !== b.target) {
          return a.target.localeCompare(b.target);
        }
        return Number(a.caseSensitive) - Number(b.caseSensitive);
      });

    const payload = JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl || '',
      targetLanguage: settings.targetLanguage,
      glossary: normalizedGlossary,
    });

    return crypto.createHash('md5').update(payload).digest('hex');
  }

  async getApiKey(): Promise<string | undefined> {
    // Check workspace-level first
    let apiKey = await this.context.secrets.get('rosettaMark.apiKey.workspace');
    if (apiKey) {
      return apiKey;
    }

    // Fallback to global
    apiKey = await this.context.secrets.get('rosettaMark.apiKey.global');
    return apiKey;
  }

  async setApiKey(apiKey: string, scope: ConfigScope = 'global'): Promise<void> {
    const key = `rosettaMark.apiKey.${scope}`;
    await this.context.secrets.store(key, apiKey);
  }

  async clearApiKey(scope?: ConfigScope): Promise<void> {
    if (!scope || scope === 'workspace') {
      await this.context.secrets.delete('rosettaMark.apiKey.workspace');
    }
    if (!scope || scope === 'global') {
      await this.context.secrets.delete('rosettaMark.apiKey.global');
    }
  }
}
