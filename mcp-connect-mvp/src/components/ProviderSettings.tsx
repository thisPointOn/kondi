import { useState, useEffect, type FC } from 'react';
import {
  Check,
  X,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  Eye,
  EyeOff,
  Zap,
  Bot,
  Cpu,
  Clock,
  TrendingUp,
  Cloud,
  Server,
  Globe,
  Sparkles,
  Brain,
  Layers,
  GitBranch,
  ExternalLink,
  LogOut,
} from 'lucide-react';
import './ProviderSettings.css';

// ============================================================================
// Types
// ============================================================================

export type AuthMethod = 'api-key' | 'oauth' | 'cli' | 'local';

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  models: ModelInfo[];
  status: 'active' | 'inactive' | 'error';
  lastUsed?: string;
  /** Supported authentication methods */
  authMethods?: AuthMethod[];
  /** CLI tool name for OAuth (e.g., 'codex', 'claude', 'gemini') */
  cliTool?: string;
  /** Whether OAuth credentials are available from CLI */
  oauthAvailable?: boolean;
  /** Whether the OAuth token has expired */
  oauthExpired?: boolean;
  /** Currently active auth method for this provider */
  activeAuthMethod?: 'oauth' | 'api_key';
  /** Validation error from startup validation */
  validationError?: {
    message: string;
    details?: string;
    action?: string;
  };
  usageStats?: {
    totalRequests: number;
    successRate: number;
    avgLatency: number;
  };
  config: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    baseUrl?: string;
    maxRetries?: number;
    timeout?: number;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  capabilities: string[];
  pricing?: {
    input: number;
    output: number;
  };
}

export interface ProviderSettingsProps {
  providers: ProviderInfo[];
  defaultProvider?: string;
  defaultModel?: string;
  onProviderUpdate: (providerId: string, config: Partial<ProviderInfo['config']>) => void;
  onDefaultChange: (providerId: string, modelId: string) => void;
  onValidateCredentials: (providerId: string) => Promise<boolean>;
  onRefreshStatus: () => void;
  /** Callback when user wants to use CLI OAuth */
  onCLILogin?: (providerId: string, cliTool: string) => Promise<boolean>;
  /** Callback to check CLI credentials availability */
  onCheckCLICredentials?: () => Promise<Record<string, boolean>>;
  /** Callback to disconnect OAuth credentials */
  onDisconnectOAuth?: (providerId: string) => void;
  /** Callback to switch auth method */
  onAuthMethodChange?: (providerId: string, method: 'oauth' | 'api_key') => void;
  /** Callback to start OAuth login flow */
  onStartOAuthLogin?: (providerId: string) => Promise<boolean>;
  /** Callback to disconnect + re-authenticate (switch account) */
  onSwitchAccount?: (providerId: string) => Promise<boolean>;
  /** Callback to run automated Codex CLI login */
  onCodexLogin?: () => Promise<void>;
  /** Whether Codex login is in progress */
  isCodexLoggingIn?: boolean;
}

// ============================================================================
// Component
// ============================================================================

const ProviderSettings: FC<ProviderSettingsProps> = ({
  providers,
  defaultProvider,
  defaultModel,
  onProviderUpdate,
  onDefaultChange,
  onValidateCredentials,
  onRefreshStatus,
  onAuthMethodChange,
  onDisconnectOAuth,
  onStartOAuthLogin,
  onSwitchAccount,
  onCodexLogin,
  isCodexLoggingIn,
}: ProviderSettingsProps) => {
  console.log('[ProviderSettings] Render with:', { defaultProvider, defaultModel });
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [validating, setValidating] = useState<string | null>(null);
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({});
  const [keyValues, setKeyValues] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  // Initialize key values from providers
  useEffect(() => {
    const keys: Record<string, string> = {};
    for (const provider of providers) {
      keys[provider.id] = provider.config.apiKey || '';
    }
    setKeyValues(keys);
  }, [providers]);

  const handleValidate = async (providerId: string) => {
    setValidating(providerId);
    try {
      await onValidateCredentials(providerId);
    } finally {
      setValidating(null);
    }
  };

  const handleSaveKey = (providerId: string) => {
    onProviderUpdate(providerId, { apiKey: keyValues[providerId] });
    setEditingKeys((prev) => ({ ...prev, [providerId]: false }));
  };

  const toggleExpanded = (providerId: string) => {
    setExpandedProvider((prev) => (prev === providerId ? null : providerId));
  };

  // Get active providers (those with credentials configured)
  const activeProviders = providers.filter(p => p.status === 'active');
  // Match provider by exact ID
  const currentProvider = providers.find(p => p.id === defaultProvider);
  const currentModel = currentProvider?.models.find(m => m.id === defaultModel);

  return (
    <div className="provider-settings">
      <div className="provider-settings-header">
        <div className="header-left">
          <Cpu size={20} />
          <h2>LLM Providers</h2>
        </div>
        <button className="refresh-btn" onClick={onRefreshStatus} title="Refresh status">
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Default LLM Display */}
      <div className="default-llm-selector">
        <div className="default-llm-header">
          <Sparkles size={18} />
          <span>Default LLM</span>
        </div>
        {currentProvider && currentModel ? (
          <div className="default-llm-display">
            <div className="default-provider-name">{currentProvider.name}</div>
            <div className="default-llm-info">
              <span className="model-info">
                <Bot size={14} />
                {currentModel.name}
              </span>
              <span className="context-info">
                <Layers size={14} />
                {(currentModel.contextWindow / 1000).toFixed(0)}K context
              </span>
              <span className="capabilities-info">
                {currentModel.capabilities.slice(0, 3).join(' · ')}
              </span>
            </div>
          </div>
        ) : (
          <div className="default-llm-empty">
            <span>No default selected</span>
          </div>
        )}
        <p className="default-llm-hint">
          Expand a provider below and click "Set Default" on a model to change.
        </p>
      </div>

      <div className="provider-list">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            isDefault={provider.id === defaultProvider}
            defaultModel={provider.id === defaultProvider ? defaultModel : undefined}
            isExpanded={expandedProvider === provider.id}
            isValidating={validating === provider.id}
            isEditingKey={editingKeys[provider.id] || false}
            keyValue={keyValues[provider.id] || ''}
            showKey={showKeys[provider.id] || false}
            onToggleExpand={() => toggleExpanded(provider.id)}
            onValidate={() => handleValidate(provider.id)}
            onSetDefault={(modelId) => {
              console.log('[ProviderCard] onSetDefault called:', provider.id, modelId);
              onDefaultChange(provider.id, modelId);
            }}
            onStartEditKey={() => setEditingKeys((prev) => ({ ...prev, [provider.id]: true }))}
            onCancelEditKey={() => setEditingKeys((prev) => ({ ...prev, [provider.id]: false }))}
            onSaveKey={() => handleSaveKey(provider.id)}
            onKeyChange={(value) => setKeyValues((prev) => ({ ...prev, [provider.id]: value }))}
            onToggleShowKey={() => setShowKeys((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
            onConfigUpdate={(config) => onProviderUpdate(provider.id, config)}
            onRefreshOAuth={() => {
              // Re-read credentials from CLI config files (like OpenClaw does)
              onRefreshStatus();
            }}
            onDisconnectOAuth={() => {
              // Clear OAuth credentials via parent handler
              if (onDisconnectOAuth) {
                onDisconnectOAuth(provider.id);
              }
              // Also clear from config
              onProviderUpdate(provider.id, { accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
            }}
            onAuthMethodChange={(method) => onAuthMethodChange?.(provider.id, method)}
            onStartOAuthLogin={async () => {
              if (onStartOAuthLogin) {
                return onStartOAuthLogin(provider.id);
              }
              return false;
            }}
            onSwitchAccount={onSwitchAccount ? async () => {
              return onSwitchAccount(provider.id);
            } : undefined}
            onCodexLogin={provider.id === 'openai' ? onCodexLogin : undefined}
            isCodexLoggingIn={isCodexLoggingIn}
          />
        ))}

        {providers.length === 0 && (
          <div className="no-providers">
            <AlertCircle size={24} />
            <p>No LLM providers configured</p>
            <span>Add API keys to enable AI capabilities</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Provider Card
// ============================================================================

interface ProviderCardProps {
  provider: ProviderInfo;
  isDefault: boolean;
  defaultModel?: string;
  isExpanded: boolean;
  isValidating: boolean;
  isEditingKey: boolean;
  keyValue: string;
  showKey: boolean;
  onToggleExpand: () => void;
  onValidate: () => void;
  onSetDefault: (modelId: string) => void;
  onStartEditKey: () => void;
  onCancelEditKey: () => void;
  onSaveKey: () => void;
  onKeyChange: (value: string) => void;
  onToggleShowKey: () => void;
  onConfigUpdate: (config: Partial<ProviderInfo['config']>) => void;
  onDisconnectOAuth?: () => void;
  onRefreshOAuth?: () => void;
  onAuthMethodChange?: (method: 'oauth' | 'api_key') => void;
  onStartOAuthLogin?: () => Promise<boolean>;
  onSwitchAccount?: () => Promise<boolean>;
  onCodexLogin?: () => Promise<void>;
  isCodexLoggingIn?: boolean;
}

const ProviderCard: FC<ProviderCardProps> = ({
  provider,
  isDefault,
  defaultModel,
  isExpanded,
  isValidating,
  isEditingKey,
  keyValue,
  showKey,
  onToggleExpand,
  onValidate,
  onSetDefault,
  onStartEditKey,
  onCancelEditKey,
  onSaveKey,
  onKeyChange,
  onToggleShowKey,
  onConfigUpdate,
  onDisconnectOAuth,
  onRefreshOAuth,
  onAuthMethodChange,
  onStartOAuthLogin,
  onSwitchAccount,
  onCodexLogin,
  isCodexLoggingIn,
}) => {
  console.log('[ProviderCard] Render:', provider.id, { isDefault, defaultModel });
  const [showOAuthMenu, setShowOAuthMenu] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const ProviderIcon = getProviderIcon(provider.id);

  return (
    <div className={`provider-card ${provider.status}`}>
      <div className="provider-card-header" onClick={onToggleExpand}>
        <div className="provider-info">
          <div className={`provider-icon ${provider.id}`}>
            <ProviderIcon size={20} />
          </div>
          <div className="provider-details">
            <div className="provider-name-row">
              <span className="provider-name">{provider.name}</span>
              {isDefault && <span className="default-badge">Default</span>}
            </div>
            <span className="provider-description">{provider.description}</span>
          </div>
        </div>
        <div className="provider-status-area">
          {provider.validationError && (
            <div className="validation-error-icon" title={provider.validationError.message}>
              <AlertCircle size={18} className="error-icon" />
            </div>
          )}
          {provider.oauthExpired && !provider.validationError && (
            <div className="validation-warning-icon" title="OAuth token expired — click to reconnect">
              <AlertCircle size={18} className="warning-icon" />
            </div>
          )}
          <StatusIndicator status={provider.status} />
          <ChevronDown
            size={18}
            className={`expand-icon ${isExpanded ? 'expanded' : ''}`}
          />
        </div>
      </div>

      {isExpanded && (
        <div className="provider-card-content">
          {/* Validation Error Banner */}
          {provider.validationError && (
            <div className="validation-error-banner">
              <div className="error-banner-header">
                <AlertCircle size={16} />
                <span className="error-message">{provider.validationError.message}</span>
              </div>
              {provider.validationError.details && (
                <p className="error-details">{provider.validationError.details}</p>
              )}
              {provider.validationError.action && (
                <div className="error-action-row">
                  {/* Show automated login button for ChatGPT CLI */}
                  {onCodexLogin && provider.validationError.action.toLowerCase().includes('codex login') ? (
                    <button
                      className="auto-login-btn"
                      onClick={onCodexLogin}
                      disabled={isCodexLoggingIn}
                    >
                      {isCodexLoggingIn ? (
                        <>
                          <RefreshCw size={14} className="spinning" />
                          Logging in...
                        </>
                      ) : (
                        'Login to ChatGPT'
                      )}
                    </button>
                  ) : (
                    <p className="error-action">
                      <strong>Fix:</strong> {provider.validationError.action}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Authentication Section — hide entirely for local-only providers */}
          {!(provider.authMethods?.length === 1 && provider.authMethods[0] === 'local') && (
          <div className="config-section">
            <label className="config-label">Authentication</label>

            {/* Active Auth Method Indicator */}
            {(provider.oauthAvailable || provider.config.apiKey) && (
              <div className="active-auth-indicator">
                <span className="active-auth-label">Using:</span>
                <span className={`active-auth-method ${provider.activeAuthMethod || 'api_key'}`}>
                  {provider.activeAuthMethod === 'oauth' ? (
                    <>
                      <ExternalLink size={12} />
                      Subscription (OAuth)
                    </>
                  ) : (
                    <>
                      <Zap size={12} />
                      API Key
                    </>
                  )}
                </span>
              </div>
            )}

            {/* OAuth Option (if available) */}
            {provider.cliTool && (
              <div className={`auth-option oauth-option ${provider.activeAuthMethod === 'oauth' ? 'active-method' : ''}`}>
                <div className="oauth-header-row">
                  <div className="oauth-left">
                    <input
                      type="radio"
                      name={`auth-method-${provider.id}`}
                      checked={provider.activeAuthMethod === 'oauth'}
                      onChange={() => onAuthMethodChange?.('oauth')}
                      disabled={!provider.oauthAvailable}
                      className="auth-radio"
                    />
                    <span className="oauth-badge">
                      <ExternalLink size={12} />
                      OAuth
                    </span>
                    <span className="oauth-cli-name">Subscription</span>
                  </div>
                  <div className="oauth-status-wrapper">
                    {provider.oauthAvailable && !provider.oauthExpired ? (
                      <button
                        className="oauth-status-btn connected"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowOAuthMenu(!showOAuthMenu);
                        }}
                      >
                        <span className="status-dot-small green" />
                        Connected
                        <ChevronDown size={12} className={showOAuthMenu ? 'rotated' : ''} />
                      </button>
                    ) : provider.oauthExpired ? (
                      <button
                        className="oauth-status-btn expired"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowOAuthMenu(!showOAuthMenu);
                        }}
                      >
                        <span className="status-dot-small orange" />
                        Expired
                        <ChevronDown size={12} className={showOAuthMenu ? 'rotated' : ''} />
                      </button>
                    ) : (
                      <button
                        className="oauth-status-btn disconnected"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (onStartOAuthLogin) {
                            setIsConnecting(true);
                            try {
                              await onStartOAuthLogin();
                            } finally {
                              setIsConnecting(false);
                            }
                          } else {
                            // Fallback to refresh if no OAuth login handler
                            onRefreshOAuth?.();
                          }
                        }}
                        disabled={isValidating || isConnecting}
                      >
                        {(isValidating || isConnecting) ? (
                          <RefreshCw size={12} className="spinning" />
                        ) : (
                          <span className="status-dot-small gray" />
                        )}
                        {isConnecting ? 'Connecting...' : isValidating ? 'Checking...' : 'Connect'}
                      </button>
                    )}
                    {/* Dropdown menu */}
                    {showOAuthMenu && provider.oauthAvailable && (
                      <div className="oauth-dropdown">
                        {provider.oauthExpired && onStartOAuthLogin && (
                          <button
                            className="oauth-dropdown-item"
                            onClick={async (e) => {
                              e.stopPropagation();
                              setShowOAuthMenu(false);
                              setIsConnecting(true);
                              try {
                                await onStartOAuthLogin();
                              } finally {
                                setIsConnecting(false);
                              }
                            }}
                          >
                            <RefreshCw size={14} />
                            Reconnect
                          </button>
                        )}
                        <button
                          className="oauth-dropdown-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRefreshOAuth?.();
                            setShowOAuthMenu(false);
                          }}
                        >
                          <RefreshCw size={14} />
                          Refresh Connection
                        </button>
                        {onSwitchAccount && (
                          <button
                            className="oauth-dropdown-item"
                            onClick={async (e) => {
                              e.stopPropagation();
                              setShowOAuthMenu(false);
                              setIsConnecting(true);
                              try {
                                await onSwitchAccount();
                              } finally {
                                setIsConnecting(false);
                              }
                            }}
                          >
                            <LogOut size={14} />
                            Switch Account
                          </button>
                        )}
                        <button
                          className="oauth-dropdown-item danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDisconnectOAuth?.();
                            setShowOAuthMenu(false);
                          }}
                        >
                          <X size={14} />
                          Disconnect
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {provider.oauthAvailable ? (
                  <div className="oauth-info">
                    <p className="oauth-detail">
                      Using subscription credentials (OAuth token)
                    </p>
                    {provider.config.expiresAt && (
                      <span className="token-expiry">
                        <Clock size={11} />
                        Expires: {new Date(provider.config.expiresAt).toLocaleString()}
                      </span>
                    )}
                    <p className="oauth-hint">
                      To re-authenticate: run <code>{provider.cliTool}</code> in terminal, then click Refresh
                    </p>
                  </div>
                ) : (
                  <div className="oauth-connect-hint">
                    <p className="oauth-instruction">
                      Click Connect to import credentials from <code>{provider.cliTool}</code> CLI
                    </p>
                    <p className="oauth-instruction-small">
                      Uses your subscription (no API key needed)
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* API Key Option - hide for CLI-only and local-only providers */}
            {!provider.id.endsWith('-cli') && !(provider.authMethods?.length === 1 && provider.authMethods[0] === 'local') && (
              <div className={`auth-option api-key-option ${provider.activeAuthMethod !== 'oauth' ? 'active-method' : ''}`}>
                <div className="api-key-header-row">
                  <div className="api-key-left">
                    {provider.cliTool && (
                      <input
                        type="radio"
                        name={`auth-method-${provider.id}`}
                        checked={provider.activeAuthMethod !== 'oauth'}
                        onChange={() => onAuthMethodChange?.('api_key')}
                        disabled={!provider.config.apiKey}
                        className="auth-radio"
                      />
                    )}
                    <span className="api-key-badge">
                      <Zap size={12} />
                      API Key
                    </span>
                    <span className="api-key-hint">Direct API access</span>
                  </div>
                  {provider.config.apiKey && (
                    <span className="api-key-status configured">
                      <Check size={12} /> Configured
                    </span>
                  )}
                </div>
                {isEditingKey ? (
                  <div className="key-edit-row">
                    <div className="key-input-wrapper">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={keyValue}
                        onChange={(e) => onKeyChange(e.target.value)}
                        placeholder={`Enter ${provider.name} API key`}
                        className="key-input"
                      />
                      <button
                        className="toggle-visibility-btn"
                        onClick={onToggleShowKey}
                        type="button"
                      >
                        {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <div className="key-actions">
                      <button className="key-btn save" onClick={onSaveKey}>
                        <Check size={14} />
                      </button>
                      <button className="key-btn cancel" onClick={onCancelEditKey}>
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="key-display-row">
                    <span className="key-value">
                      {provider.config.apiKey
                        ? `${provider.config.apiKey.slice(0, 8)}${'•'.repeat(20)}`
                        : 'Not configured'}
                    </span>
                    <button className="edit-key-btn" onClick={onStartEditKey}>
                      Edit
                    </button>
                    {provider.config.apiKey && (
                      <button
                        className="validate-btn"
                        onClick={onValidate}
                        disabled={isValidating}
                      >
                        {isValidating ? (
                          <RefreshCw size={14} className="spinning" />
                        ) : (
                          <Check size={14} />
                        )}
                        Validate
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Models Section */}
          <div className="config-section">
            <label className="config-label">Available Models</label>
            <div className="models-list">
              {provider.models.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isDefault={model.id === defaultModel}
                  onSetDefault={() => {
                    console.log('[ModelList] Setting default:', model.id, 'current defaultModel:', defaultModel);
                    onSetDefault(model.id);
                  }}
                />
              ))}
            </div>
          </div>

          {/* Usage Stats */}
          {provider.usageStats && (
            <div className="config-section">
              <label className="config-label">Usage Statistics</label>
              <div className="stats-grid">
                <div className="stat-item">
                  <Zap size={14} />
                  <span className="stat-value">{provider.usageStats.totalRequests}</span>
                  <span className="stat-label">Requests</span>
                </div>
                <div className="stat-item">
                  <TrendingUp size={14} />
                  <span className="stat-value">{provider.usageStats.successRate}%</span>
                  <span className="stat-label">Success Rate</span>
                </div>
                <div className="stat-item">
                  <Clock size={14} />
                  <span className="stat-value">{provider.usageStats.avgLatency}ms</span>
                  <span className="stat-label">Avg Latency</span>
                </div>
              </div>
            </div>
          )}

          {/* Advanced Config */}
          <div className="config-section">
            <label className="config-label">Advanced Settings</label>
            <div className="advanced-config">
              <div className="config-row">
                <span>Max Retries</span>
                <input
                  type="number"
                  value={provider.config.maxRetries || 3}
                  onChange={(e) => onConfigUpdate({ maxRetries: parseInt(e.target.value) })}
                  min={0}
                  max={10}
                  className="config-input small"
                />
              </div>
              <div className="config-row">
                <span>Timeout (ms)</span>
                <input
                  type="number"
                  value={provider.config.timeout || 30000}
                  onChange={(e) => onConfigUpdate({ timeout: parseInt(e.target.value) })}
                  min={5000}
                  max={120000}
                  step={1000}
                  className="config-input"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Model Row
// ============================================================================

interface ModelRowProps {
  model: ModelInfo;
  isDefault: boolean;
  onSetDefault: () => void;
}

const ModelRow: FC<ModelRowProps> = ({ model, isDefault, onSetDefault }) => {
  // Debug: Log every model render with its isDefault status
  console.log('[ModelRow] Render:', model.id, { isDefault });

  const handleSetDefault = () => {
    console.log('[ModelRow] Set default clicked for model:', model.id);
    onSetDefault();
  };

  return (
    <div className={`model-row ${isDefault ? 'default' : ''}`}>
      <div className="model-info">
        <span className="model-name">{model.name}</span>
        <div className="model-meta">
          <span className="context-window">{formatContextWindow(model.contextWindow)}</span>
          {model.capabilities.slice(0, 2).map((cap) => (
            <span key={cap} className="capability-badge">{cap}</span>
          ))}
        </div>
      </div>
      <div className="model-actions">
        {model.pricing && (
          <span className="model-pricing">
            ${model.pricing.input}/{model.pricing.output} per 1M
          </span>
        )}
        {isDefault ? (
          <span className="default-indicator">
            <Check size={14} /> Default
          </span>
        ) : (
          <button className="set-default-btn" onClick={handleSetDefault}>
            Set Default
          </button>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Status Indicator
// ============================================================================

const StatusIndicator: FC<{ status: ProviderInfo['status'] }> = ({ status }) => {
  const config = {
    active: { color: 'green', label: 'Active' },
    inactive: { color: 'gray', label: 'Inactive' },
    error: { color: 'red', label: 'Error' },
  };

  const { color, label } = config[status];

  return (
    <div className={`status-indicator ${color}`}>
      <span className="status-dot" />
      <span className="status-label">{label}</span>
    </div>
  );
};

// ============================================================================
// Helpers
// ============================================================================

function getProviderIcon(providerId: string) {
  switch (providerId) {
    // Primary providers
    case 'anthropic':
    case 'anthropic-cli':
    case 'anthropic-api':
      return Bot;
    case 'openai':
    case 'openai-cli':
    case 'openai-api':
    case 'openai-oauth':
      return Cpu;
    case 'gemini':
    case 'google':
      return Sparkles;
    case 'xai':
      return Brain;

    // OAuth/Device-code providers
    case 'copilot':
      return GitBranch;

    // OpenAI-compatible providers
    case 'openrouter':
      return Layers;
    case 'groq':
      return Zap;
    case 'together':
      return Globe;
    case 'deepseek':
      return Brain;
    case 'moonshot':
      return Sparkles;
    case 'venice':
      return Cloud;
    case 'xiaomi':
      return Cpu;

    // Local providers
    case 'ollama':
      return Server;

    // Cloud providers
    case 'bedrock':
      return Cloud;

    default:
      return Zap;
  }
}

// Provider category for grouping in UI
export type ProviderCategory = 'primary' | 'oauth' | 'openai-compatible' | 'local' | 'cloud';

export function getProviderCategory(providerId: string): ProviderCategory {
  switch (providerId) {
    case 'anthropic':
    case 'openai':
    case 'gemini':
      return 'primary';
    case 'openai-oauth':
    case 'copilot':
      return 'oauth';
    case 'openrouter':
    case 'groq':
    case 'together':
    case 'deepseek':
    case 'moonshot':
    case 'venice':
    case 'xiaomi':
      return 'openai-compatible';
    case 'ollama':
      return 'local';
    case 'bedrock':
      return 'cloud';
    default:
      return 'openai-compatible';
  }
}

export function getProviderDescription(providerId: string): string {
  switch (providerId) {
    case 'anthropic':
      return 'Claude models with advanced reasoning';
    case 'openai':
      return 'GPT-4 and o1 models via API key';
    case 'openai-oauth':
      return 'OpenAI via OAuth authentication';
    case 'gemini':
      return 'Google Gemini with API key or OAuth';
    case 'copilot':
      return 'GitHub Copilot via device code login';
    case 'openrouter':
      return 'Access 100+ models via single API';
    case 'groq':
      return 'Ultra-fast inference on Groq hardware';
    case 'together':
      return 'Open-source models at scale';
    case 'deepseek':
      return 'DeepSeek Chat and Coder models';
    case 'moonshot':
      return 'Moonshot/Kimi long-context models';
    case 'venice':
      return 'Privacy-focused AI inference';
    case 'xiaomi':
      return 'Xiaomi MiMo language models';
    case 'ollama':
      return 'Local LLM inference';
    case 'bedrock':
      return 'AWS Bedrock multi-model access';
    default:
      return 'LLM provider';
  }
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M ctx`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K ctx`;
  }
  return `${tokens} ctx`;
}

export default ProviderSettings;
