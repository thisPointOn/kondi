import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppView } from '../components/Sidebar';
import { openaiClient } from '../services/openaiClient';
import { anthropicClient } from '../services/anthropicClient';
import type { MCPTool, Message } from '../types/mcp';
import { invoke } from '@tauri-apps/api/core';

type ChatRecord = Record<string, Message[]>;
const MAX_CHATS = 20;
const CHAT_STORAGE_KEY = 'mcp-chats';
const CHAT_WORKING_DIRS_KEY = 'kondi-chat-working-dirs';

interface UseChatsParams {
  setCurrentView: (view: AppView) => void;
  provider: 'claude' | 'chatgpt';
  openaiKey: string;
  anthropicKey: string;
  openaiModel: string;
  anthropicModel: string;
  globalWorkingDirectory?: string;
}

export function useChats({
  setCurrentView,
  provider,
  openaiKey,
  anthropicKey,
  openaiModel,
  anthropicModel,
  globalWorkingDirectory,
}: UseChatsParams) {
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRecord>({});
  const [hasLoadedChats, setHasLoadedChats] = useState(false);
  const [messageCountToday, setMessageCountToday] = useState(0);
  const [pendingToolInsert, setPendingToolInsert] = useState<string | null>(null);
  const [chatSending, setChatSending] = useState(false);
  const [chatActiveProvider, setChatActiveProvider] = useState<string | null>(null);

  // Per-chat working directories
  const [chatWorkingDirs, setChatWorkingDirs] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(CHAT_WORKING_DIRS_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  const hasLoadedChatsRef = useRef(false);

  // Persist per-chat working directories
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_WORKING_DIRS_KEY, JSON.stringify(chatWorkingDirs));
    } catch (e) {
      console.warn('[useChats] Failed to save chat working dirs:', e);
    }
  }, [chatWorkingDirs]);

  const setChatWorkingDir = (chatId: string, dir: string | null) => {
    setChatWorkingDirs((prev) => {
      if (dir === null) {
        const next = { ...prev };
        delete next[chatId];
        return next;
      }
      return { ...prev, [chatId]: dir };
    });
  };

  // Load chats on mount - try Tauri first, then localStorage
  useEffect(() => {
    if (hasLoadedChatsRef.current) return;
    hasLoadedChatsRef.current = true;

    (async () => {
      let loaded = false;

      // Try Tauri file storage first
      try {
        const tauriChats = await invoke<string | null>('load_chats');
        if (tauriChats) {
          const parsed: { id: string; messages: Message[]; updatedAt?: number }[] = JSON.parse(tauriChats);
          const sorted = parsed
            .map((c) => ({
              id: c.id,
              messages: c.messages || [],
              updatedAt: c.updatedAt || (c.messages?.[c.messages.length - 1]?.timestamp
                ? new Date(c.messages[c.messages.length - 1].timestamp).getTime()
                : 0),
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_CHATS);
          if (sorted.length > 0) {
            console.log('[useChats] Loaded', sorted.length, 'chats from Tauri storage');
            setChats(Object.fromEntries(sorted.map((c) => [c.id, c.messages])));
            setCurrentChatId(sorted[0].id);
            loaded = true;
          }
        }
      } catch (e) {
        console.warn('[useChats] Failed to load chats from Tauri:', e);
      }

      // Fall back to localStorage
      if (!loaded) {
        const savedChats = localStorage.getItem(CHAT_STORAGE_KEY);
        if (savedChats) {
          try {
            const parsed: { id: string; messages: Message[]; updatedAt?: number }[] = JSON.parse(savedChats);
            const sorted = parsed
              .map((c) => ({
                id: c.id,
                messages: c.messages || [],
                updatedAt: c.updatedAt || (c.messages?.[c.messages.length - 1]?.timestamp
                  ? new Date(c.messages[c.messages.length - 1].timestamp).getTime()
                  : 0),
              }))
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, MAX_CHATS);
            if (sorted.length > 0) {
              console.log('[useChats] Loaded', sorted.length, 'chats from localStorage');
              setChats(Object.fromEntries(sorted.map((c) => [c.id, c.messages])));
              setCurrentChatId(sorted[0].id);
            }
          } catch (e) {
            console.error('Failed to load saved chats from localStorage:', e);
          }
        }
      }

      setHasLoadedChats(true);
    })();
  }, []);

  // Create a default chat if none loaded (only after we've attempted to load)
  useEffect(() => {
    if (hasLoadedChats && !currentChatId) {
      const newId = crypto.randomUUID();
      setCurrentChatId(newId);
      setChats({ [newId]: [] });
    }
  }, [currentChatId, hasLoadedChats]);

  // Persist chats (keep only last MAX_CHATS by recency, only after initial load)
  useEffect(() => {
    if (!hasLoadedChats) return;
    const entries = Object.entries(chats).map(([id, messages]) => {
      // Strip file contents from messages to save space
      const lightMessages = messages.map((m) => {
        let content = m.content;
        if (m.attachments && m.attachments.length > 0) {
          const fileMarker = '\n\n--- File:';
          const markerIndex = content.indexOf(fileMarker);
          if (markerIndex > -1) {
            content = content.slice(0, markerIndex) + '\n\n[File attachments not saved]';
          }
        }
        // Truncate very long messages to prevent storage overflow
        if (content.length > 10000) {
          content = content.slice(0, 10000) + '\n\n[Message truncated for storage]';
        }
        return { ...m, content };
      });
      const updatedAt =
        messages.length > 0
          ? new Date(messages[messages.length - 1].timestamp || Date.now()).getTime()
          : 0;
      return { id, messages: lightMessages, updatedAt };
    });
    const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
    const data = JSON.stringify(sorted);

    // Save to Tauri file storage (primary)
    invoke('save_chats', { chats: data })
      .then(() => console.log('[useChats] Chats saved to Tauri storage'))
      .catch((e) => console.warn('[useChats] Failed to save chats to Tauri:', e));

    // Also save to localStorage as backup
    try {
      if (data.length > 4 * 1024 * 1024) {
        console.warn('[useChats] Chat data too large for localStorage, trimming');
        const trimmed = sorted.slice(0, Math.max(5, Math.floor(sorted.length / 2)));
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
      } else {
        localStorage.setItem(CHAT_STORAGE_KEY, data);
      }
    } catch (e) {
      console.warn('[useChats] Failed to save chats to localStorage:', e);
    }
  }, [chats, hasLoadedChats]);

  const handleNewChat = () => {
    const id = crypto.randomUUID();
    setChats((prev) => ({ ...prev, [id]: [] }));
    if (globalWorkingDirectory) {
      setChatWorkingDir(id, globalWorkingDirectory);
    }
    setCurrentChatId(id);
    setCurrentView('chat');
  };

  const handleChatMessagesChange = (chatId: string, messages: Message[]) => {
    setChats((prev) => {
      const prevMessages = prev[chatId] || [];
      const newUserMessages = messages.filter(
        (m) => m.role === 'user' && !prevMessages.find((pm) => pm.id === m.id)
      );
      if (newUserMessages.length > 0) {
        setMessageCountToday((c) => c + newUserMessages.length);
      }
      return { ...prev, [chatId]: messages };
    });
  };

  const handleDeleteChat = (chatId: string) => {
    setChats((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    setChatWorkingDir(chatId, null);
    if (currentChatId === chatId) {
      const remainingIds = Object.keys(chats).filter((id) => id !== chatId);
      setCurrentChatId(remainingIds[0] || null);
    }
  };

  // Run LLM check comparing manifest vs README and post result to a new chat
  const handleGithubCheck = async (params: { repoUrl: string; manifestRaw: string; readmeText: string }) => {
    const { repoUrl, manifestRaw, readmeText } = params;
    const trimmedReadme = readmeText ? readmeText.slice(0, 6000) : 'README not available.';
    const trimmedManifest = manifestRaw ? manifestRaw.slice(0, 6000) : '{}';

    const prompt = `You are auditing an MCP server manifest against its README to spot risks and missing pieces.\n\nRepo: ${repoUrl}\n\nManifest (JSON):\n${trimmedManifest}\n\nREADME excerpt:\n${trimmedReadme}\n\nCheck:\n- Is the package name/version pinned and safe?\n- Does entrypoint look reasonable for MCP stdio?\n- Required env vars present/clear?\n- Any mismatches or missing info?\nReturn a concise bullet summary (3-6 bullets) with risks/warnings first.`;

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: prompt,
      timestamp: new Date(),
    };

    const available = new Map<string, { serverId: string; tools: MCPTool[] }>();

    try {
      let assistantMessage;
      if (provider === 'chatgpt' && openaiKey) {
        const res = await openaiClient.chat([userMessage], available, openaiModel);
        assistantMessage = { ...res.message, timestamp: new Date() };
      } else if (anthropicKey) {
        const res = await anthropicClient.chat([userMessage], available, anthropicModel);
        assistantMessage = { ...res.message, timestamp: new Date() };
      } else if (openaiKey) {
        const res = await openaiClient.chat([userMessage], available, openaiModel);
        assistantMessage = { ...res.message, timestamp: new Date() };
      } else {
        throw new Error('No LLM provider configured. Add credentials in LLM Providers settings.');
      }

      const chatId = crypto.randomUUID();
      setChats((prev) => ({
        ...prev,
        [chatId]: [userMessage, assistantMessage],
      }));
      setCurrentChatId(chatId);
      setCurrentView('chat');
    } catch (err) {
      console.error('[GitHub LLM check] failed:', err);
      // eslint-disable-next-line no-alert
      alert(`LLM check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const chatMessages = currentChatId ? chats[currentChatId] || [] : [];

  const sidebarChats = useMemo(
    () =>
      Object.entries(chats)
        .map(([id, messages]) => ({
          id,
          title: messages[0]?.content?.slice(0, 28) || 'New Chat',
          timestamp: messages[0]?.timestamp
            ? new Date(messages[0].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '',
          updatedAt:
            messages.length > 0
              ? new Date(messages[messages.length - 1].timestamp || Date.now()).getTime()
              : 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHATS),
    [chats],
  );

  return {
    currentChatId,
    setCurrentChatId,
    chats,
    hasLoadedChats,
    messageCountToday,
    pendingToolInsert,
    setPendingToolInsert,
    chatSending,
    setChatSending,
    chatActiveProvider,
    setChatActiveProvider,
    chatMessages,
    sidebarChats,
    handleNewChat,
    handleChatMessagesChange,
    handleDeleteChat,
    handleGithubCheck,
    chatWorkingDirs,
    setChatWorkingDir,
  } as const;
}
