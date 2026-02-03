/**
 * Validation Banner Component
 * Shows startup validation status to users
 */

import { type FC, useState } from 'react';
import { AlertTriangle, CheckCircle, XCircle, ChevronDown, RefreshCw, X, Info } from 'lucide-react';
import type { StartupValidationReport, ValidationResult } from '../services/startupValidator';
import './ValidationBanner.css';

interface ValidationBannerProps {
  report: StartupValidationReport | null;
  isValidating: boolean;
  onRevalidate?: () => void;
  onDismiss?: () => void;
  onCodexLogin?: () => Promise<void>;
  isCodexLoggingIn?: boolean;
}

const ValidationBanner: FC<ValidationBannerProps> = ({
  report,
  isValidating,
  onRevalidate,
  onDismiss,
  onCodexLogin,
  isCodexLoggingIn,
}) => {
  const [expanded, setExpanded] = useState(true); // Start expanded to show issues

  // Show loading state during validation
  if (isValidating) {
    return (
      <div className="validation-banner validating">
        <div className="banner-content">
          <RefreshCw size={16} className="spinning" />
          <span>Validating connections...</span>
        </div>
      </div>
    );
  }

  // Don't show anything if no report or all healthy
  if (!report || report.overallStatus === 'healthy') {
    return null;
  }

  const errors = [
    ...report.llmProviders.filter(r => r.status === 'error'),
    ...report.mcpServers.filter(r => r.status === 'error'),
  ];
  const warnings = [
    ...report.llmProviders.filter(r => r.status === 'warning'),
    ...report.mcpServers.filter(r => r.status === 'warning'),
  ];
  const hasIssues = errors.length > 0 || warnings.length > 0;
  const issueCount = errors.length + warnings.length;

  return (
    <div className={`validation-banner ${report.overallStatus}`}>
      <div className="banner-content">
        <div className="banner-main" onClick={() => hasIssues && setExpanded(!expanded)}>
          {report.overallStatus === 'critical' ? (
            <XCircle size={16} className="status-icon critical" />
          ) : report.overallStatus === 'degraded' ? (
            <AlertTriangle size={16} className="status-icon warning" />
          ) : (
            <CheckCircle size={16} className="status-icon ok" />
          )}

          <span className="banner-message">
            {report.overallStatus === 'critical'
              ? `No working LLM providers - check your settings`
              : report.overallStatus === 'degraded'
              ? `${issueCount} connection issue(s) found`
              : 'All connections verified'}
          </span>

          {hasIssues && (
            <ChevronDown
              size={16}
              className={`expand-icon ${expanded ? 'expanded' : ''}`}
            />
          )}
        </div>

        <div className="banner-actions">
          {onRevalidate && (
            <button className="banner-btn" onClick={onRevalidate} title="Re-validate">
              <RefreshCw size={14} />
            </button>
          )}
          {onDismiss && (
            <button className="banner-btn" onClick={onDismiss} title="Dismiss">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {expanded && hasIssues && (
        <div className="banner-details">
          {/* LLM Provider Issues */}
          {report.llmProviders.filter(r => r.status === 'error' || r.status === 'warning').length > 0 && (
            <div className="detail-section">
              <span className="detail-title">LLM Providers</span>
              {report.llmProviders
                .filter(r => r.status === 'error' || r.status === 'warning')
                .map((result, i) => (
                  <ValidationItem
                    key={i}
                    result={result}
                    onCodexLogin={onCodexLogin}
                    isCodexLoggingIn={isCodexLoggingIn}
                  />
                ))}
            </div>
          )}

          {/* MCP Server Issues */}
          {report.mcpServers.filter(r => r.status === 'error' || r.status === 'warning').length > 0 && (
            <div className="detail-section">
              <span className="detail-title">MCP Servers</span>
              {report.mcpServers
                .filter(r => r.status === 'error' || r.status === 'warning')
                .map((result, i) => (
                  <ValidationItem key={i} result={result} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface ValidationItemProps {
  result: ValidationResult;
  onCodexLogin?: () => Promise<void>;
  isCodexLoggingIn?: boolean;
}

const ValidationItem: FC<ValidationItemProps> = ({ result, onCodexLogin, isCodexLoggingIn }) => {
  // Check if this is a Codex login issue that we can auto-fix
  const isCodexLoginAction = result.action?.toLowerCase().includes('codex login') ||
    result.action?.toLowerCase().includes('codex') && result.details?.toLowerCase().includes('not logged in');

  return (
    <div className={`validation-item ${result.status}`}>
      {result.status === 'error' ? (
        <XCircle size={14} className="item-icon error" />
      ) : result.status === 'warning' ? (
        <AlertTriangle size={14} className="item-icon warning" />
      ) : (
        <Info size={14} className="item-icon info" />
      )}
      <div className="item-content">
        <div className="item-header">
          <span className="item-name">{result.provider}</span>
          <span className={`item-status ${result.status}`}>{result.message}</span>
        </div>
        {result.details && <span className="item-details">{result.details}</span>}
        {result.action && (
          <div className="item-action-row">
            {isCodexLoginAction && onCodexLogin ? (
              <button
                className="auto-login-btn"
                onClick={onCodexLogin}
                disabled={isCodexLoggingIn}
              >
                {isCodexLoggingIn ? (
                  <>
                    <RefreshCw size={12} className="spinning" />
                    Logging in...
                  </>
                ) : (
                  'Login to Codex'
                )}
              </button>
            ) : (
              <span className="item-action">
                <strong>Fix:</strong> {result.action}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ValidationBanner;
