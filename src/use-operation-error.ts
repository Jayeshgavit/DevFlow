import { useCallback, useEffect, useState } from 'react';

/** Identical failures do not restart the timer or create another notification. */
export function useOperationError(persistent = false) {
  const [notice, update] = useState({ message: '', persistent });
  const setError = useCallback((message: string, keep = persistent) => update(current =>
    current.message === message && current.persistent === keep ? current : { message, persistent: keep }), [persistent]);
  useEffect(() => {
    if (!notice.message || notice.persistent) return;
    const timer = setTimeout(() => update(current => ({ ...current, message: '' })), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice.message, setError] as const;
}
