/**
 * FlowForge Logger
 * Structured logging for workflow execution
 */

// ============================================================================
// Log Types
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: Error;
}

export interface LogContext {
  workflowId?: string;
  executionId?: string;
  stepId?: string;
  attemptNumber?: number;
  providerId?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  /** Minimum log level to output */
  level?: LogLevel;

  /** Include timestamps in console output */
  timestamps?: boolean;

  /** Pretty print JSON */
  prettyPrint?: boolean;

  /** Custom log handler */
  handler?: (entry: LogEntry) => void;

  /** Context to include in all log entries */
  defaultContext?: LogContext;
}

// ============================================================================
// Log Level Priority
// ============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================================================
// Logger Class
// ============================================================================

export class Logger {
  private config: Required<LoggerConfig>;
  private context: LogContext;

  constructor(config?: LoggerConfig) {
    this.config = {
      level: config?.level || 'info',
      timestamps: config?.timestamps ?? true,
      prettyPrint: config?.prettyPrint ?? false,
      handler: config?.handler || this.defaultHandler.bind(this),
      defaultContext: config?.defaultContext || {},
    };
    this.context = { ...this.config.defaultContext };
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    const childLogger = new Logger({
      ...this.config,
      defaultContext: { ...this.context, ...context },
    });
    return childLogger;
  }

  /**
   * Set additional context for this logger
   */
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const err = error instanceof Error ? error : error ? new Error(String(error)) : undefined;
    this.log('error', message, context, err);
  }

  /**
   * Core log method
   */
  private log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context, ...context },
      error,
    };

    this.config.handler(entry);
  }

  /**
   * Default log handler (console output)
   */
  private defaultHandler(entry: LogEntry): void {
    const parts: string[] = [];

    if (this.config.timestamps) {
      parts.push(`[${entry.timestamp}]`);
    }

    parts.push(`[${entry.level.toUpperCase()}]`);
    parts.push(entry.message);

    const contextEntries = Object.entries(entry.context || {}).filter(
      ([_, v]) => v !== undefined
    );

    if (contextEntries.length > 0) {
      const contextStr = this.config.prettyPrint
        ? JSON.stringify(Object.fromEntries(contextEntries), null, 2)
        : JSON.stringify(Object.fromEntries(contextEntries));
      parts.push(contextStr);
    }

    const logFn = this.getConsoleFn(entry.level);
    logFn(parts.join(' '));

    if (entry.error) {
      console.error(entry.error);
    }
  }

  private getConsoleFn(level: LogLevel): typeof console.log {
    switch (level) {
      case 'debug':
        return console.debug;
      case 'info':
        return console.info;
      case 'warn':
        return console.warn;
      case 'error':
        return console.error;
      default:
        return console.log;
    }
  }
}

// ============================================================================
// Workflow-Specific Loggers
// ============================================================================

/**
 * Create a logger for a workflow execution
 */
export function createExecutionLogger(
  workflowId: string,
  executionId: string,
  config?: LoggerConfig
): Logger {
  return new Logger({
    ...config,
    defaultContext: {
      ...config?.defaultContext,
      workflowId,
      executionId,
    },
  });
}

/**
 * Create a logger for a step execution
 */
export function createStepLogger(
  workflowId: string,
  executionId: string,
  stepId: string,
  config?: LoggerConfig
): Logger {
  return new Logger({
    ...config,
    defaultContext: {
      ...config?.defaultContext,
      workflowId,
      executionId,
      stepId,
    },
  });
}

// ============================================================================
// Log Aggregator
// ============================================================================

export interface LogAggregatorConfig {
  /** Maximum entries to keep */
  maxEntries?: number;

  /** Log level to capture */
  level?: LogLevel;
}

export class LogAggregator {
  private entries: LogEntry[] = [];
  private maxEntries: number;
  private level: LogLevel;

  constructor(config?: LogAggregatorConfig) {
    this.maxEntries = config?.maxEntries || 1000;
    this.level = config?.level || 'debug';
  }

  /**
   * Create a handler that captures logs
   */
  createHandler(): (entry: LogEntry) => void {
    return (entry: LogEntry) => {
      if (LOG_LEVELS[entry.level] < LOG_LEVELS[this.level]) {
        return;
      }

      this.entries.push(entry);

      // Trim old entries
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }
    };
  }

  /**
   * Get all captured entries
   */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries filtered by level
   */
  getEntriesByLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  /**
   * Get entries filtered by context
   */
  getEntriesByContext(context: Partial<LogContext>): LogEntry[] {
    return this.entries.filter((entry) => {
      for (const [key, value] of Object.entries(context)) {
        if (entry.context?.[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get entry count
   */
  get count(): number {
    return this.entries.length;
  }
}

// ============================================================================
// Default Logger Instance
// ============================================================================

let defaultLogger: Logger | null = null;

export function getDefaultLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger({
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
    });
  }
  return defaultLogger;
}

export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}

// ============================================================================
// Convenience Functions
// ============================================================================

export function debug(message: string, context?: LogContext): void {
  getDefaultLogger().debug(message, context);
}

export function info(message: string, context?: LogContext): void {
  getDefaultLogger().info(message, context);
}

export function warn(message: string, context?: LogContext): void {
  getDefaultLogger().warn(message, context);
}

export function error(message: string, err?: Error | unknown, context?: LogContext): void {
  getDefaultLogger().error(message, err, context);
}
