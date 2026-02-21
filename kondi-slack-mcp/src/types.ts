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

// --- Slack API response types ---

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export interface SlackMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
}

export interface SlackReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  topic: { value: string };
  purpose: { value: string };
  num_members: number;
}

// --- Tool response types ---

export interface PostMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  message: SlackMessage;
}

export interface ConversationsHistoryResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface ConversationsRepliesResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
}

export interface ConversationsListResponse extends SlackApiResponse {
  channels: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

export interface ReactionsAddResponse extends SlackApiResponse {}
