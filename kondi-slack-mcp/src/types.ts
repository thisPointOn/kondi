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

export interface ReactionsRemoveResponse extends SlackApiResponse {}

export interface SearchMessagesResponse extends SlackApiResponse {
  messages: {
    total: number;
    matches: SlackSearchMatch[];
  };
}

export interface SlackSearchMatch {
  type: string;
  user: string;
  username: string;
  text: string;
  ts: string;
  channel: {
    id: string;
    name: string;
  };
  permalink: string;
}

export interface SlackUserProfile {
  real_name?: string;
  display_name?: string;
  email?: string;
  title?: string;
  status_text?: string;
  status_emoji?: string;
  image_48?: string;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile: SlackUserProfile;
  is_admin: boolean;
  is_bot: boolean;
  is_app_user: boolean;
  deleted: boolean;
  tz?: string;
  tz_label?: string;
}

export interface UsersInfoResponse extends SlackApiResponse {
  user: SlackUser;
}

export interface UsersListResponse extends SlackApiResponse {
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
}

export interface ChatUpdateResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  text: string;
}

export interface ChatDeleteResponse extends SlackApiResponse {
  channel: string;
  ts: string;
}

export interface ConversationsInfoResponse extends SlackApiResponse {
  channel: SlackChannel;
}

export interface PinsAddResponse extends SlackApiResponse {}

export interface SlackPinnedItem {
  type: string;
  channel: string;
  message?: SlackMessage;
  created: number;
  created_by: string;
}

export interface PinsListResponse extends SlackApiResponse {
  items: SlackPinnedItem[];
}

export interface ReactionsGetResponse extends SlackApiResponse {
  message: SlackMessage;
  channel: string;
}
