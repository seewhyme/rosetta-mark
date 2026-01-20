# Change Log

## [0.1.0]

### Added
- Initial release of Rosetta Mark
- Multi-provider AI support (OpenAI, Google Gemini, Anthropic Claude, Ollama)
- Context-aware Markdown translation preserving code blocks, frontmatter, and formatting
- Hash-based incremental translation caching to avoid re-translating unchanged documents
- Split view preview that automatically opens translation side-by-side with source
- Secure API key storage with VS Code SecretStorage
- Custom base URL support for proxies and OpenAI-compatible APIs
- Real-time streaming translation progress with token usage reporting
- Batch translation for multiple files
- Selection translation for partial content
- Reverse translation to update source files from translated content
- Custom glossary support for consistent terminology translation

### Features
- Command: `Rosetta Mark: Translate Markdown` - Translate entire markdown files
- Command: `Rosetta Mark: Set API Key` - Securely store API keys
- Command: `Rosetta Mark: Batch Translate` - Translate multiple files at once
- Command: `Rosetta Mark: Translate Selection` - Translate selected text
- Command: `Rosetta Mark: Reverse Translate to Source` - Apply changes back to source
- Editor toolbar buttons for quick access
- Keyboard shortcuts: `Cmd+Shift+T` (translate), `Cmd+Alt+T` (selection)
- Automatic cache invalidation on file changes
- Configurable preview modes (editor, preview, or both)
