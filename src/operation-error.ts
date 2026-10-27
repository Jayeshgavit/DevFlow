import { redactForSharing } from './log-utils';

/** Tauri rejects with strings; JS failures usually carry Error.message. */
export function errorMessage(cause: unknown): string {
  const message = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '';
  return redactForSharing(message.trim() || 'The operation could not be completed. Please retry and check DevFlow logs if it continues.');
}

export function closeOperation(label: string, event: string): 'shutdown_app' | 'editor_close' | undefined {
  if (event === 'app-close-requested' && (label === 'main' || label === 'quick-editor')) return 'shutdown_app';
  if (event === 'editor-close' && label === 'quick-editor') return 'editor_close';
}
