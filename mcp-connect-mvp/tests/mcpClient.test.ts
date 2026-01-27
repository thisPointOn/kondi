import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClient } from '../src/services/mcpClient';
import type { MCPServer } from '../src/types/mcp';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => {
  const invokeMock = vi.fn();
  return { invoke: invokeMock };
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
    const server = makeServer({ id: 'srv-err' });
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

  it('disconnect removes server and tools', () => {
    const server = makeServer();
    // @ts-expect-error access private
    mcp.servers.set(server.id, server);
    // @ts-expect-error access private
    mcp.tools.set(server.id, [{ name: 'foo', description: '', inputSchema: { type: 'object', properties: {} } }]);
    mcp.disconnect(server.id);
    expect(mcp.getAllServers()).toHaveLength(0);
    expect(mcp.getTools(server.id)).toHaveLength(0);
  });
});
