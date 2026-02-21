export interface ApiConfig {
  base_url: string;
  timeout_ms: number;
}

export interface AuthConfig {
  bot_token: string;
}

export interface ServerConfig {
  transport: 'stdio' | 'sse';
  port: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

export interface Config {
  api: ApiConfig;
  auth: AuthConfig;
  server: ServerConfig;
}

// Discord API response types

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
  global_name?: string | null;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  embeds: DiscordEmbed[];
  pinned: boolean;
  type: number;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  topic?: string | null;
  position?: number;
  nsfw?: boolean;
  parent_id?: string | null;
  last_message_id?: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  owner_id: string;
  approximate_member_count?: number;
  approximate_presence_count?: number;
  features: string[];
  [key: string]: unknown;
}

export interface DiscordGuildMember {
  user?: DiscordUser;
  nick: string | null;
  roles: string[];
  joined_at: string;
  deaf: boolean;
  mute: boolean;
}

export interface DiscordApiError {
  code: number;
  message: string;
  errors?: Record<string, unknown>;
}
