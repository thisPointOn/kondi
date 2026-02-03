/**
 * FlowForge Event Broadcaster
 * SSE event streaming for real-time execution updates
 */

import { Response } from 'express';
import { ExecutorEvent } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface SSEClient {
  id: string;
  executionId: string;
  response: Response;
  connectedAt: Date;
}

export interface BroadcastOptions {
  /** Target specific execution */
  executionId?: string;
  /** Target specific client */
  clientId?: string;
}

// ============================================================================
// Event Broadcaster
// ============================================================================

export class EventBroadcaster {
  private clients: Map<string, SSEClient> = new Map();
  private clientsByExecution: Map<string, Set<string>> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start heartbeat to keep connections alive
    this.startHeartbeat();
  }

  /**
   * Register a new SSE client
   */
  addClient(clientId: string, executionId: string, response: Response): void {
    // Set up SSE headers
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Store client
    const client: SSEClient = {
      id: clientId,
      executionId,
      response,
      connectedAt: new Date(),
    };

    this.clients.set(clientId, client);

    // Index by execution
    if (!this.clientsByExecution.has(executionId)) {
      this.clientsByExecution.set(executionId, new Set());
    }
    this.clientsByExecution.get(executionId)!.add(clientId);

    // Send initial connection event
    this.sendToClient(clientId, {
      type: 'connected',
      clientId,
      executionId,
      timestamp: new Date().toISOString(),
    });

    // Handle client disconnect
    response.on('close', () => {
      this.removeClient(clientId);
    });
  }

  /**
   * Remove a client
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      // Remove from execution index
      const executionClients = this.clientsByExecution.get(client.executionId);
      if (executionClients) {
        executionClients.delete(clientId);
        if (executionClients.size === 0) {
          this.clientsByExecution.delete(client.executionId);
        }
      }

      // Remove client
      this.clients.delete(clientId);
    }
  }

  /**
   * Broadcast an executor event
   */
  broadcast(event: ExecutorEvent, options?: BroadcastOptions): void {
    const eventData = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    });

    if (options?.clientId) {
      // Send to specific client
      this.sendRawToClient(options.clientId, event.type, eventData);
    } else if (options?.executionId) {
      // Send to all clients watching this execution
      const clientIds = this.clientsByExecution.get(options.executionId);
      if (clientIds) {
        for (const clientId of clientIds) {
          this.sendRawToClient(clientId, event.type, eventData);
        }
      }
    } else {
      // Broadcast to all clients
      for (const clientId of this.clients.keys()) {
        this.sendRawToClient(clientId, event.type, eventData);
      }
    }
  }

  /**
   * Broadcast to all clients watching a specific execution
   */
  broadcastToExecution(executionId: string, event: ExecutorEvent): void {
    this.broadcast(event, { executionId });
  }

  /**
   * Get connected client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get clients for an execution
   */
  getExecutionClients(executionId: string): SSEClient[] {
    const clientIds = this.clientsByExecution.get(executionId);
    if (!clientIds) return [];

    return Array.from(clientIds)
      .map((id) => this.clients.get(id))
      .filter((c): c is SSEClient => c !== undefined);
  }

  /**
   * Check if execution has connected clients
   */
  hasClients(executionId: string): boolean {
    const clients = this.clientsByExecution.get(executionId);
    return clients !== undefined && clients.size > 0;
  }

  /**
   * Stop the broadcaster
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all connections
    for (const client of this.clients.values()) {
      try {
        client.response.end();
      } catch {
        // Ignore errors during cleanup
      }
    }

    this.clients.clear();
    this.clientsByExecution.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private sendToClient(clientId: string, data: unknown): void {
    const eventType = typeof data === 'object' && data !== null && 'type' in data
      ? (data as { type: string }).type
      : 'message';
    this.sendRawToClient(clientId, eventType, JSON.stringify(data));
  }

  private sendRawToClient(clientId: string, eventType: string, data: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      client.response.write(`event: ${eventType}\n`);
      client.response.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected, remove it
      this.removeClient(clientId);
    }
  }

  private startHeartbeat(): void {
    // Send heartbeat every 30 seconds to keep connections alive
    this.heartbeatInterval = setInterval(() => {
      const heartbeat = JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
      });

      for (const clientId of this.clients.keys()) {
        this.sendRawToClient(clientId, 'heartbeat', heartbeat);
      }
    }, 30000);
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultBroadcaster: EventBroadcaster | null = null;

export function getDefaultBroadcaster(): EventBroadcaster {
  if (!defaultBroadcaster) {
    defaultBroadcaster = new EventBroadcaster();
  }
  return defaultBroadcaster;
}

export function setDefaultBroadcaster(broadcaster: EventBroadcaster): void {
  defaultBroadcaster = broadcaster;
}

// ============================================================================
// Helper Functions
// ============================================================================

export function broadcastExecutorEvent(event: ExecutorEvent): void {
  const executionId = 'workflowId' in event ? event.workflowId : undefined;
  getDefaultBroadcaster().broadcast(event, { executionId });
}

export function createEventHandler(): (event: ExecutorEvent) => void {
  return (event: ExecutorEvent) => {
    broadcastExecutorEvent(event);
  };
}
