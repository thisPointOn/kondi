import { useState } from 'react';

export function useAppUpdates(appVersion: string) {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState<string>('Not checked yet.');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  const handleCheckUpdates = async () => {
    setUpdateStatus('checking');
    setUpdateMessage('Checking for updates…');
    setUpdateAvailable(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch('https://example.com/mcp-connect/version.json', {
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      const version = data.version || 'unknown';
      const notes = data.notes || '';
      setLatestVersion(version);
      const availableFlag =
        typeof data.updateAvailable === 'boolean'
          ? data.updateAvailable
          : version !== 'unknown' && version !== appVersion;
      setUpdateAvailable(availableFlag);
      setUpdateStatus('ok');
      setUpdateMessage(
        availableFlag
          ? `Update available: ${version}${notes ? ` — ${notes}` : ''}`
          : `You are up to date (current ${appVersion})${notes ? ` — ${notes}` : ''}`,
      );
    } catch (err) {
      clearTimeout(timer);
      setUpdateStatus('error');
      setUpdateMessage(
        err instanceof Error ? `Update check failed: ${err.message}` : 'Update check failed',
      );
    }
  };

  return {
    updateStatus,
    updateMessage,
    updateAvailable,
    latestVersion,
    handleCheckUpdates,
  } as const;
}
