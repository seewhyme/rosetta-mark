# Rosetta Mark

AI-powered Markdown translation for VS Code, built for docs that change over time. Rosetta Mark preserves Markdown structure, reuses unchanged paragraph translations, and keeps generated translations in VS Code storage instead of writing cache files into your project.

![Rosetta Mark Demo](images/demo.gif)

## Features

- **Multi-provider support**: OpenAI, Google Gemini, Anthropic Claude, Ollama, and OpenRouter.
- **Bring your own key**: API keys are stored in VS Code SecretStorage, globally or per workspace.
- **Validated setup**: Rosetta Mark checks the API key before saving when the provider is reachable.
- **Markdown-aware translation**: Preserves frontmatter, code blocks, inline literals, placeholders, HTML/XML tags, and Markdown syntax.
- **Incremental updates**: Reuses unchanged paragraph translations so small edits to long documents finish quickly.
- **Fast large-file mode**: Configurable request batching and concurrency for high-throughput models.
- **Workspace-safe cache**: Translation cache lives in VS Code workspace storage, isolated by provider/model/language/glossary settings.
- **Batch and selection workflows**: Translate one file, a selection, selected files, a folder, or all Markdown files in a workspace.
- **Progress and cancellation**: Status bar feedback, progress notifications, and Escape/cancel support for active jobs.

## Setup

### 1. Install the Extension

Install from VS Code Marketplace or download the `.vsix` file.
Marketplace: [seewhyme.rosetta-mark](https://marketplace.visualstudio.com/items?itemName=seewhyme.rosetta-mark)

### 2. Set Your API Key

Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:
```
Rosetta Mark: Set API Key
```
Choose where to store it:

- **Global (User)**: available to all projects.
- **Workspace**: only available to the current VS Code workspace.

Rosetta Mark validates the key before saving when the selected provider can be reached. If validation cannot run because of a network issue, the key is still saved.

### 3. Configure Global Settings

You can configure Rosetta Mark globally (for all projects) in two ways:

#### Option A: Settings UI (Recommended)

1. Open VS Code Settings:
   - **Mac**: `Cmd+,`
   - **Windows/Linux**: `Ctrl+,`
   - Or: `Cmd+Shift+P` → "Preferences: Open Settings (UI)"

2. Search for "Rosetta Mark" in the search bar

3. Configure your preferences:
   - **Provider**: Choose your AI provider (OpenAI, Google, Anthropic, Ollama, OpenRouter)
   - **Model**: Set the model name
   - **Base URL**: Set a proxy, OpenAI-compatible endpoint, or local Ollama endpoint
   - **Target Language**: Set your default translation language
   - **Preview Mode**: Choose how to display translations
   - **Max Concurrency / Max Batch Tokens**: Tune speed and rate-limit behavior
   - **Glossary**: Add custom terminology mappings
   - **Cache Retention / Cache Size**: Control automatic translation cache cleanup

#### Option B: settings.json (Advanced)

1. Open settings.json:
   - `Cmd+Shift+P` → "Preferences: Open User Settings (JSON)"

2. Add your configuration:
```json
{
  "rosettaMark.provider": "openai",
  "rosettaMark.model": "gpt-4o-mini",
  "rosettaMark.targetLanguage": "zh-CN",
  "rosettaMark.previewMode": "preview",
  "rosettaMark.maxConcurrency": 3,
  "rosettaMark.maxBatchTokens": 4000,
  "rosettaMark.cache.retentionDays": 30,
  "rosettaMark.cache.maxSizeMB": 500,
  "rosettaMark.glossary": [
    {
      "source": "API",
      "target": "应用程序接口",
      "caseSensitive": false
    }
  ]
}
```

> **💡 Tip**: For project-specific settings, create `.vscode/settings.json` in your project root. Project settings override global settings.

## Configuration

### Available Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `rosettaMark.provider` | string | `openai` | AI provider: `openai`, `google`, `anthropic`, `ollama`, `openrouter` |
| `rosettaMark.model` | string | `gpt-4o-mini` | Model name (e.g., `gpt-4o-mini`, `claude-3-5-sonnet-20241022`) |
| `rosettaMark.targetLanguage` | string | `zh-CN` | Target language code (e.g., `zh-CN`, `en`, `ja`, `es`) |
| `rosettaMark.baseUrl` | string | `""` | Custom API base URL (for proxies or OpenAI-compatible APIs) |
| `rosettaMark.previewMode` | string | `preview` | Display mode: `editor` (split view), `preview` (split view), or `both` (editor + preview) |
| `rosettaMark.maxConcurrency` | number | `4` | Max parallel translation requests (1-16). See [Performance Tuning](#performance-tuning). |
| `rosettaMark.maxBatchTokens` | number | `4000` | Max estimated tokens per batched request (chars/4). See [Performance Tuning](#performance-tuning). |
| `rosettaMark.glossary` | array | `[]` | Custom terminology for consistent translation |
| `rosettaMark.cache.retentionDays` | number | `30` | Days to keep unused cached translations. Set to `0` to disable age-based cleanup. |
| `rosettaMark.cache.maxSizeMB` | number | `500` | Maximum translation cache size per workspace. Set to `0` to disable size-based cleanup. |

### Glossary Configuration

Add custom terminology to ensure consistent translations:

```json
{
  "rosettaMark.glossary": [
    {
      "source": "frontend",
      "target": "前端",
      "caseSensitive": false
    },
    {
      "source": "API",
      "target": "应用程序接口",
      "caseSensitive": true
    }
  ]
}
```

## Usage

### Quick Start

1. Open a Markdown file
2. Click the globe icon in the editor toolbar, or
3. Use keyboard shortcut: `Cmd+Shift+T` (Mac) / `Ctrl+Shift+T` (Windows/Linux)
4. Or open Command Palette and run `Rosetta Mark: Translate Markdown`

### Translation Process

The extension will:
- Check whether the current source/configuration already has an up-to-date translation.
- Reuse unchanged paragraph translations from the cache.
- Translate changed content while preserving Markdown formatting.
- Save the generated translation under VS Code workspace storage.
- Open the translation beside the source file, depending on `rosettaMark.previewMode`.

![Split View Preview](images/screenshot-preview.png)

### Advanced Features

**Batch Translation**: Right-click on a folder in Explorer and select "Batch Translate" to translate multiple files at once.

**Selection Translation**: Select any text and use `Cmd+Alt+T` (Mac) / `Ctrl+Alt+T` (Windows/Linux) to translate only the selected portion.

**Cancel Translation**: Use the progress notification cancel button, press `Escape`, or run `Rosetta Mark: Cancel Translation`.

**Clean Translation Cache**: Run `Rosetta Mark: Clean Translation Cache` to remove expired cache entries or clear all cached translations for the selected workspace.

## Commands

| Command | Description |
|---|---|
| `Rosetta Mark: Translate Markdown` | Translate the active Markdown file |
| `Rosetta Mark: Translate Selection` | Replace the selected text with its translation |
| `Rosetta Mark: Batch Translate` | Translate selected files, a folder, or all Markdown files in the workspace |
| `Rosetta Mark: Set API Key` | Save a global or workspace API key |
| `Rosetta Mark: Cancel Translation` | Cancel active translation work |
| `Rosetta Mark: Clean Translation Cache` | Clean expired cache or clear workspace cache |

## Translation Cache

Translations are stored in VS Code's workspace storage, not in your project directory, so projects do not need a `.gitignore` entry for Rosetta Mark output. The cache still mirrors the source file structure and is isolated by workspace and translation configuration.

Rosetta Mark automatically cleans the current workspace cache on extension startup and after saving a translation. By default it removes cached translations that have not been used for 30 days and keeps the workspace cache under 500 MB. Run `Rosetta Mark: Clean Translation Cache` from the Command Palette to clean expired entries or clear all cached translations for the current workspace.

If an old project-local `.rosetta-mark/` cache exists, Rosetta Mark copies it into VS Code storage the first time the workspace is used. It does not delete the old project-local folder automatically.

## Supported Providers

### OpenAI
```json
{
  "rosettaMark.provider": "openai",
  "rosettaMark.model": "gpt-4o-mini"
}
```

### Google Gemini
```json
{
  "rosettaMark.provider": "google",
  "rosettaMark.model": "gemini-2.0-flash-exp"
}
```

### Anthropic Claude
```json
{
  "rosettaMark.provider": "anthropic",
  "rosettaMark.model": "claude-3-5-sonnet-20241022"
}
```

### Ollama (Local)
```json
{
  "rosettaMark.provider": "ollama",
  "rosettaMark.model": "llama3.2",
  "rosettaMark.baseUrl": "http://localhost:11434/v1"
}
```

### OpenRouter
```json
{
  "rosettaMark.provider": "openrouter",
  "rosettaMark.model": "google/gemini-3.1-flash-lite:nitro"
}
```

## Performance Tuning

The defaults (`maxConcurrency=4`, `maxBatchTokens=4000`) are a safe middle ground that works well across all providers and document sizes. If you translate large documents frequently and want to squeeze out more speed, tune these two settings based on your provider and model.

### How they interact

- **`maxBatchTokens`** controls how many paragraphs are merged into a single request. Larger = fewer requests, but each request takes longer to generate.
- **`maxConcurrency`** controls how many requests run in parallel. More workers help only when there are enough batches to feed them.

The two settings interact: if `maxBatchTokens` is large, the whole document may fit in just 1–2 batches, and extra workers will sit idle. If `maxBatchTokens` is too small, prompt overhead is repeated many times and the batch-level latency floor adds up.

### Per-provider recommendations

| Provider / Model | `maxConcurrency` | `maxBatchTokens` | Notes |
|---|---|---|---|
| **OpenRouter `:nitro` fast models** (e.g. `google/gemini-3.1-flash-lite:nitro`) | `8` | `2500–3000` | Highest throughput; nitro routing handles high concurrency well |
| OpenAI / Azure OpenAI | `4–8` | `4000` | Defaults are fine; `gpt-4o-mini` style models scale to 8 |
| Anthropic Claude | `4` | `4000` | Anthropic has stricter per-key rate limits |
| OpenRouter (standard) / DeepSeek | `3–4` | `4000` | Going above 4 often gets throttled per upstream provider |
| Ollama (local) | `1–2` | `2000` | Local hardware is the bottleneck; large batches hold memory longer |

### Real-world benchmark

A 54 KB / 190-paragraph README translated end-to-end (155 paragraphs needing translation, 35 reused as code/frontmatter):

| Model | `maxConcurrency` | `maxBatchTokens` | Time |
|---|---|---|---|
| `google/gemini-3.1-flash-lite:nitro` | 8 | 3000 | **12.3s** |
| `google/gemini-3.1-flash-lite:nitro` | 4 | 4000 | 17.5s |
| `gpt-4o-mini` class | 4 | 4000 | ~40s |
| `deepseek/deepseek-v4-flash` | 4 | 4000 | ~60s |

### Quick rules

- If translations feel slow on a fast cloud model: try lowering `maxBatchTokens` to `2500` first, then raising `maxConcurrency` to `8`.
- If you hit 429 rate-limit errors: lower `maxConcurrency` to `2–3`, keep `maxBatchTokens` at `4000` or higher to compensate.
- Incremental re-translation is mostly limited by the number of *changed* paragraphs, not these settings — small edits to a long document complete in seconds regardless.

## Troubleshooting

### Common Issues

**"API Key not set" error**
- Run `Rosetta Mark: Set API Key` from Command Palette
- Make sure you're using the correct API key for your selected provider

**Translation is slow on large files**
- Try `maxConcurrency=8` and `maxBatchTokens=2500–3000` on fast cloud models
- For local Ollama, use `maxConcurrency=1–2` and smaller batches

**Formatting lost after translation**
- Make sure your markdown is valid
- Code blocks should have language identifiers
- Report formatting issues on GitHub

**Rate limit errors**
- Reduce `maxConcurrency` to 2 or 3
- Wait a few minutes before retrying
- Keep `maxBatchTokens` at 4000 or higher to reduce the number of requests

**Old `.rosetta-mark/` folder still exists**
- New translations are stored in VS Code workspace storage
- Rosetta Mark copies an old project-local cache into VS Code storage on first use
- The old folder is not deleted automatically

## Development

```bash
# Install dependencies
pnpm install

# Compile
pnpm run compile

# Watch mode
pnpm run watch

# Run tests
pnpm test

# Lint
pnpm run lint

# Format code
pnpm run format
```

## License

MIT - see [LICENSE](LICENSE) file for details

---

Made by [seewhyme](https://github.com/seewhyme).

*If this extension helps you, please consider [starring the repo](https://github.com/seewhyme/rosetta-mark).*
