let channel: { appendLine(msg: string): void } | undefined;

export function initLogger(context: import('vscode').ExtensionContext) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require('vscode') as typeof import('vscode');
  const ch = vscode.window.createOutputChannel('Rosetta Mark');
  channel = ch;
  context.subscriptions.push(ch);
}

export function log(msg: string) {
  channel?.appendLine(`[INFO] ${msg}`);
}

export function warn(msg: string) {
  channel?.appendLine(`[WARN] ${msg}`);
}

export function error(msg: string, err?: unknown) {
  if (!channel) return;
  channel.appendLine(`[ERROR] ${msg}`);
  if (err instanceof Error) {
    channel.appendLine(`  ${err.message}`);
  }
}
