import type { Config, DiscordMessage, DiscordChannel, DiscordEmbed, DiscordGuild, DiscordGuildMember } from './types.js';

export class DiscordClient {
  private baseUrl: string;
  private botToken: string;
  private timeout: number;

  constructor(config: Config) {
    this.baseUrl = config.api.base_url.replace(/\/$/, '');
    this.botToken = config.auth.bot_token;
    this.timeout = config.api.timeout_ms;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      };

      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      // 204 No Content (e.g., reaction created)
      if (response.status === 204) {
        return {} as T;
      }

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = (data as { message?: string }).message || response.statusText;
        const errorCode = (data as { code?: number }).code || response.status;
        throw new Error(`Discord API error ${errorCode}: ${errorMsg}`);
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timed out after ${this.timeout}ms`);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Could not connect to Discord API at ${this.baseUrl}`);
        }
        throw error;
      }
      throw new Error('Unknown Discord API error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
    embed?: DiscordEmbed
  ): Promise<DiscordMessage> {
    const body: Record<string, unknown> = { content };
    if (embed) {
      body.embeds = [embed];
    }
    return this.request<DiscordMessage>('POST', `/channels/${channelId}/messages`, body);
  }

  async getMessages(channelId: string, limit: number = 50): Promise<DiscordMessage[]> {
    const clampedLimit = Math.min(Math.max(1, limit), 100);
    return this.request<DiscordMessage[]>(
      'GET',
      `/channels/${channelId}/messages?limit=${clampedLimit}`
    );
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    return this.request<DiscordChannel>('GET', `/channels/${channelId}`);
  }

  async listGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.request<DiscordChannel[]>('GET', `/guilds/${guildId}/channels`);
  }

  async createReaction(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const encodedEmoji = encodeURIComponent(emoji);
    await this.request<Record<string, never>>(
      'PUT',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`
    );
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string
  ): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(
      'PATCH',
      `/channels/${channelId}/messages/${messageId}`,
      { content }
    );
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request<Record<string, never>>(
      'DELETE',
      `/channels/${channelId}/messages/${messageId}`
    );
  }

  async getGuild(guildId: string): Promise<DiscordGuild> {
    return this.request<DiscordGuild>(
      'GET',
      `/guilds/${guildId}?with_counts=true`
    );
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    await this.request<Record<string, never>>(
      'PUT',
      `/channels/${channelId}/pins/${messageId}`
    );
  }

  async getPinnedMessages(channelId: string): Promise<DiscordMessage[]> {
    return this.request<DiscordMessage[]>(
      'GET',
      `/channels/${channelId}/pins`
    );
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
    autoArchiveDuration?: number
  ): Promise<DiscordChannel> {
    const body: Record<string, unknown> = { name };
    if (autoArchiveDuration !== undefined) {
      body.auto_archive_duration = autoArchiveDuration;
    }
    return this.request<DiscordChannel>(
      'POST',
      `/channels/${channelId}/messages/${messageId}/threads`,
      body
    );
  }

  async getGuildMembers(guildId: string, limit: number = 100): Promise<DiscordGuildMember[]> {
    const clampedLimit = Math.min(Math.max(1, limit), 1000);
    return this.request<DiscordGuildMember[]>(
      'GET',
      `/guilds/${guildId}/members?limit=${clampedLimit}`
    );
  }

  async removeReaction(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const encodedEmoji = encodeURIComponent(emoji);
    await this.request<Record<string, never>>(
      'DELETE',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Use /gateway which doesn't require auth to verify API reachability,
      // then check token by hitting /users/@me
      await this.request<{ id: string }>('GET', '/users/@me');
      return true;
    } catch {
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  hasToken(): boolean {
    return this.botToken.length > 0;
  }
}
