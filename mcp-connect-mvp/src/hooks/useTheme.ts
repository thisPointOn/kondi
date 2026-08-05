import { useEffect, useState } from 'react';
import { safeSetItem } from '../utils/safeStorage';

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('mcp-theme');
    return saved === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    document.body.classList.toggle('light-theme', theme === 'light');
    document.body.classList.toggle('dark-theme', theme !== 'light');
    safeSetItem('mcp-theme', theme);
  }, [theme]);

  return { theme, setTheme } as const;
}
