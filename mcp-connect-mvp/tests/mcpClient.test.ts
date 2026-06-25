import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClient } from '../src/services/mcpClient';
import type { MCPServer } from '../src/types/mcp';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => {
  const invokeMock = vi.fn();
  return { invoke: invokeMock };
});

vi.mock('../src/services/proxyService', () => {
  return {
    isProxyRunning: vi.fn().mockResolvedValue(true),
    startProxy: vi.fn().mockResolvedValue(3000),
    stopProxy: vi.fn().mockResolvedValue(undefined),
    getProxyConfig: vi.fn().mockResolvedValue({ localPort: 3000 }),
    getProxyHealth: vi.fn().mockResolvedValue({ status: 'connected' }),
    reauthenticateProxy: vi.fn(),
    syncProxyToClaudeConfig: vi.fn().mockResolvedValue(undefined),
    syncProxyToCodexConfig: vi.fn().mockResolvedValue(undefined),
  };
});

const makeServer = (overrides?: Partial<MCPServer>): MCPServer => ({
  id: 'srv-1',
  name: 'Test',
  url: 'http://localhost:3000',
  transport: 'http',
  status: 'disconnected',
  ...overrides,
});

describe('MCPClient', () => {
  const mcp = new MCPClient();
  const mockedInvoke = invoke as unknown as vi.MockedFunction<any>;

  beforeEach(() => {
    // @ts-expect-error reset private maps for tests
    mcp.servers = new Map();
    // @ts-expect-error reset private maps for tests
    mcp.tools = new Map();
    // @ts-expect-error reset private request ID counter
    mcp.requestId = 0;
    mockedInvoke.mockReset();
  });

  it('connects to HTTP server and stores tools', async () => {
    const server = makeServer();
    mockedInvoke
      // initialize
      .mockResolvedValueOnce('{}')
      // tools/list
      .mockResolvedValueOnce(JSON.stringify({
        tools: [{ name: 'foo', description: '', inputSchema: { type: 'object', properties: {} } }],
      }));

    await mcp.connectServer(server);
    const all = mcp.getAllServers();
    expect(all[0]?.status).toBe('connected');
    const tools = mcp.getTools(server.id);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('foo');
  });

  it('fails connect sets status error', async () => {
    // Force transport to stdio so it doesn't go through connectViaProxy for this simple error test
    const server = makeServer({ id: 'srv-err', transport: 'stdio', type: 'github_mcp_local' });
    // Add dummy manifest to avoid missing manifest error
    server.metadata = {
      manifest: {
        name: 'error-server',
        version: '1.0.0',
        run: { command: 'node' }
      }
    };
    mockedInvoke.mockRejectedValue(new Error('boom'));
    await expect(mcp.connectServer(server)).rejects.toThrow();
    const all = mcp.getAllServers();
    expect(all[0]?.status).toBe('error');
  });

  it('calls tool on connected server', async () => {
    const server = makeServer();
    // prime state
    // @ts-expect-error access private
    mcp.servers.set(server.id, { ...server, status: 'connected' });
    mockedInvoke.mockResolvedValueOnce(JSON.stringify({
      content: [{ type: 'text', text: 'hello' }],
    }));

    const result = await mcp.callTool(server.id, 'foo', { a: 1 });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(result[0]?.text).toBe('hello');
  });

  it('disconnect keeps server but removes tools', () => {
    const server = makeServer();
    // @ts-expect-error access private
    mcp.servers.set(server.id, server);
    // @ts-expect-error access private
    mcp.tools.set(server.id, [{ name: 'foo', description: '', inputSchema: { type: 'object', properties: {} } }]);
    mcp.disconnect(server.id);
    expect(mcp.getAllServers()).toHaveLength(1);
    expect(mcp.getAllServers()[0].status).toBe('disconnected');
    expect(mcp.getTools(server.id)).toHaveLength(0);
  });
});

describe('Well-known MCP Servers integration', () => {
  const mcp = new MCPClient();
  const mockedInvoke = invoke as unknown as vi.MockedFunction<any>;

  beforeEach(() => {
    // @ts-expect-error reset private maps for tests
    mcp.servers = new Map();
    // @ts-expect-error reset private maps for tests
    mcp.tools = new Map();
    // @ts-expect-error reset private request ID counter
    mcp.requestId = 0;
    mockedInvoke.mockReset();
  });

  it('integrates successfully with Git MCP Server tools', async () => {
    const gitServer: MCPServer = {
      id: 'git-mcp',
      name: 'Git Server',
      url: '',
      transport: 'stdio',
      status: 'disconnected',
      metadata: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-git'],
        serverPath: '/dummy/path',
        manifest: {
          name: 'git-mcp',
          version: '1.0.0',
          run: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-git'],
          },
        },
      },
    };

    mockedInvoke
      // is_mcp_process_running
      .mockResolvedValueOnce(false)
      // get_mcp_servers_dir
      .mockResolvedValueOnce('/dummy/servers')
      // start_mcp_process
      .mockResolvedValueOnce(true)
      // send_mcp_message (initialize)
      .mockResolvedValueOnce(undefined)
      // read_mcp_response (initialize response)
      .mockResolvedValueOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: {} },
      }))
      // send_mcp_message (tools/list)
      .mockResolvedValueOnce(undefined)
      // read_mcp_response (tools/list response)
      .mockResolvedValueOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            {
              name: 'git_status',
              description: 'Get working directory status',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: 'git_diff',
              description: 'Get differences of changes',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      }));

    await mcp.connectServer(gitServer);
    const server = mcp.getAllServers().find((s) => s.id === 'git-mcp');
    expect(server?.status).toBe('connected');
    
    const tools = mcp.getTools('git-mcp');
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain('git_status');
    expect(tools.map((t) => t.name)).toContain('git_diff');
  });

  it('integrates successfully with Slack MCP Server tools', async () => {
    const slackServer: MCPServer = {
      id: 'slack-mcp',
      name: 'Slack Server',
      url: '',
      transport: 'stdio',
      status: 'disconnected',
      metadata: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        serverPath: '/dummy/path',
        manifest: {
          name: 'slack-mcp',
          version: '1.0.0',
          run: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-slack'],
          },
        },
      },
    };

    mockedInvoke
      // is_mcp_process_running
      .mockResolvedValueOnce(false)
      // get_mcp_servers_dir
      .mockResolvedValueOnce('/dummy/servers')
      // start_mcp_process
      .mockResolvedValueOnce(true)
      // send_mcp_message (initialize)
      .mockResolvedValueOnce(undefined)
      // read_mcp_response (initialize response)
      .mockResolvedValueOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: {} },
      }))
      // send_mcp_message (tools/list)
      .mockResolvedValueOnce(undefined)
      // read_mcp_response (tools/list response)
      .mockResolvedValueOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            {
              name: 'post_message',
              description: 'Post Slack message',
              inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } },
            },
          ],
        },
      }));

    await mcp.connectServer(slackServer);
    const tools = mcp.getTools('slack-mcp');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('post_message');
  });

  it('integrates successfully with SearXNG Search MCP Server tools', async () => {
    const searchServer: MCPServer = {
      id: 'search-mcp',
      name: 'SearXNG Search',
      url: '',
      transport: 'stdio',
      status: 'disconnected',
      metadata: {
        command: 'npx',
        args: ['-y', 'searxng-mcp'],
        serverPath: '/dummy/path',
        manifest: {
          name: 'search-mcp',
          version: '1.0.0',
          run: {
            command: 'npx',
            args: ['-y', 'searxng-mcp'],
          },
        },
      },
    };

    mockedInvoke
      // is_mcp_process_running
      .mockResolvedValueOnce(false)
      // get_mcp_servers_dir
      .mockResolvedValueOnce('/dummy/servers')
      // start_mcp_process
      .mockResolvedValueOnce(true)
      // send_mcp_message (initialize)
      .mockResolvedValueOnce(undefined)
      // read_mcp_response (initialize response)
      .mockResolvedValueOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: {} },
      }))
      // send_mcp_message (tools/list)
      .mockResolvedValueOnce(undefined)
      // read_mcp_response (tools/list response)
      .mockResolvedValueOnce(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            {
              name: 'web_search',
              description: 'Search the web',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      }));

    await mcp.connectServer(searchServer);
    const tools = mcp.getTools('search-mcp');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('web_search');
  });
});
