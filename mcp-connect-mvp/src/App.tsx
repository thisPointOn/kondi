import { useState } from 'react';
import Sidebar, { type AppView } from './components/Sidebar';
import ChatArea from './components/ChatArea';
import ToolsPanel from './components/ToolsPanel';
import ProviderSettings from './components/ProviderSettings';
import { PipelineLibrary, PipelineBuilder, PipelineExecutionView } from './components/pipeline';
import SearchServicePanel from './components/SearchServicePanel';
import { CouncilLibrary, CouncilView } from './components/council';
import { CollapsibleSection } from './components/CollapsibleSection';
import NewChatDialog from './components/NewChatDialog';
import PermissionDialog from './components/PermissionDialog';
import { mcpClient } from './services/mcpClient';
import { localToolsService } from './services/localTools';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import {
  useTheme,
  useAppUpdates,
  useChats,
  useProviderConfig,
  useServers,
  useCouncilHandlers,
  usePipeline,
} from './hooks';
import './App.css';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

const APP_VERSION = (pkg?.version as string) || '0.0.0';

function App() {
  const [currentView, setCurrentView] = useState<AppView>('chat');

  const { theme, setTheme } = useTheme();
  const updates = useAppUpdates(APP_VERSION);
  const providerConfig = useProviderConfig();
  const serverHook = useServers({
    hasLoadedKeys: providerConfig.hasLoadedKeys,
    validationReport: providerConfig.validationReport,
  });
  const chats = useChats({
    setCurrentView,
    provider: providerConfig.provider,
    openaiKey: providerConfig.openaiKey,
    anthropicKey: providerConfig.anthropicKey,
    openaiModel: providerConfig.openaiModel,
    anthropicModel: providerConfig.anthropicModel,
    globalWorkingDirectory: providerConfig.globalWorkingDirectory,
  });
  const council = useCouncilHandlers({
    availableTools: serverHook.availableTools,
  });
  const pipeline = usePipeline({
    availableTools: serverHook.availableTools,
    setThinkingPersonas: council.setThinkingPersonas,
  });

  const activeApiKey = providerConfig.provider === 'chatgpt' ? providerConfig.openaiKey : providerConfig.anthropicKey;

  return (
    <div className="app-container">
      <Sidebar
        className="sidebar-drawer"
        currentView={currentView}
        onViewChange={setCurrentView}
        currentChatId={chats.currentChatId}
        onChatSelect={(id) => {
          chats.setCurrentChatId(id);
          localToolsService.resetAllowAllReads();
        }}
        onNewChat={chats.requestNewChat}
        onChatDelete={chats.handleDeleteChat}
        onChatRename={chats.setChatName}
        chats={chats.sidebarChats}
        chatsSending={chats.chatsSending}
        showToolsPanel={serverHook.showToolsPanel}
        onToggleToolsPanel={() => serverHook.setShowToolsPanel((p) => !p)}
        providerErrorCount={providerConfig.validationReport?.llmProviders.filter(r => r.status === 'error').length || 0}
      />

      <div className="main-column">
        {currentView === 'pipelines' ? (
          pipeline.pipelineMode === 'execution' && pipeline.currentPipelineId ? (
            <PipelineExecutionView
              pipelineId={pipeline.currentPipelineId}
              onBack={pipeline.handleExecutionBack}
              onAbort={pipeline.handleExecutionAbort}
              gateResolvers={pipeline.gateResolvers}
              activeCouncilId={pipeline.activePipelineCouncilId}
              thinkingPersonas={council.thinkingPersonas}
              selectedCouncilId={pipeline.pipelineSelectedCouncilId}
              onSelectedCouncilChange={pipeline.setPipelineSelectedCouncilId}
              selectedStepId={pipeline.pipelineSelectedStepId}
              onSelectedStepChange={pipeline.setPipelineSelectedStepId}
              onPauseDeliberation={council.onPauseDeliberation}
              onResumeDeliberation={council.onResumeDeliberation}
              onForceDecision={council.onForceDecision}
              onAbortDeliberation={council.onAbortDeliberation}
              onUserMessage={council.onUserMessage}
              onRetryStep={pipeline.handleRetryStep}
            />
          ) : pipeline.pipelineMode === 'builder' && pipeline.currentPipelineId ? (
            <PipelineBuilder
              pipelineId={pipeline.currentPipelineId}
              connectedServers={serverHook.connectedServersForPipeline}
              configuredProviders={providerConfig.configuredProviders}
              onBack={pipeline.handlePipelineBack}
              onViewResults={pipeline.handlePipelineViewResults}
              onRun={pipeline.handlePipelineRun}
            />
          ) : (
            <PipelineLibrary
              onPipelineSelect={pipeline.handlePipelineSelect}
              onPipelineCreate={pipeline.handlePipelineCreate}
            />
          )
        ) : currentView === 'council' ? (
          council.currentCouncilId ? (
            <CouncilView
              councilId={council.currentCouncilId}
              onBack={() => council.setCurrentCouncilId(null)}
              onGenerateTurn={council.onGenerateTurn}
              onGenerateRound={council.onGenerateRound}
              onGenerateSynthesis={council.onGenerateSynthesis}
              onResolve={council.onResolve}
              onFrameProblem={council.onFrameProblem}
              onRunRound={council.onRunRound}
              onEvaluateRound={council.onEvaluateRound}
              onMakeDecision={council.onMakeDecision}
              onCreatePlan={council.onCreatePlan}
              onIssueDirective={council.onIssueDirective}
              onExecuteWork={council.onExecuteWork}
              onReviewWork={council.onReviewWork}
              onPauseDeliberation={council.onPauseDeliberation}
              onResumeDeliberation={council.onResumeDeliberation}
              onForceDecision={council.onForceDecision}
              onAbortDeliberation={council.onAbortDeliberation}
              onUserMessage={council.onUserMessage}
              configuredProviders={providerConfig.configuredProviders}
              thinkingPersonas={council.thinkingPersonas}
            />
          ) : (
            <CouncilLibrary
              onCouncilSelect={(id) => council.setCurrentCouncilId(id)}
              onCouncilCreate={(c) => council.setCurrentCouncilId(c.id)}
              defaultWorkingDirectory={providerConfig.globalWorkingDirectory}
              configuredProviders={providerConfig.configuredProviders}
            />
          )
        ) : currentView === 'providers' ? (
          <ProviderSettings
            providers={providerConfig.providersList}
            defaultProvider={providerConfig.selectedProviderId}
            defaultModel={providerConfig.selectedProviderId.startsWith('anthropic') ? providerConfig.anthropicModel : providerConfig.openaiModel}
            onProviderUpdate={providerConfig.handleProviderUpdate}
            onDefaultChange={providerConfig.handleDefaultChange}
            onValidateCredentials={providerConfig.handleValidateCredentials}
            onRefreshStatus={providerConfig.handleRefreshStatus}
            onAuthMethodChange={providerConfig.handleAuthMethodChange}
            onDisconnectOAuth={providerConfig.handleDisconnectOAuth}
            onStartOAuthLogin={providerConfig.handleStartOAuthLogin}
            onCodexLogin={providerConfig.handleCodexLogin}
            isCodexLoggingIn={providerConfig.isCodexLoggingIn}
          />
        ) : currentView === 'services' ? (
          <div className="services-pane">
            <h2>Built-in Services</h2>
            <p className="services-description">
              Manage built-in services that extend Kondi's capabilities. These services run locally
              and provide tools for your AI agents.
            </p>
            <SearchServicePanel
              mcpClient={mcpClient}
              onStatusChange={serverHook.handleSearchServiceStatusChange}
            />
          </div>
        ) : currentView === 'settings' ? (
          <div className="settings-pane">
            <h2>Settings</h2>

            <CollapsibleSection title="AI Provider" defaultOpen>
              <div className="provider-quick-status">
                <div className="current-provider">
                  <span className="provider-label">Current:</span>
                  <span className="provider-value">
                    {providerConfig.provider === 'claude' ? 'Anthropic Claude' : 'OpenAI ChatGPT'}
                  </span>
                  <span className={`status-dot ${(providerConfig.provider === 'claude' ? providerConfig.anthropicKey : providerConfig.openaiKey) ? 'active' : ''}`} />
                </div>
                <div className="current-model">
                  <span className="model-label">Model:</span>
                  <span className="model-value">
                    {providerConfig.provider === 'claude' ? providerConfig.anthropicModel : providerConfig.openaiModel}
                  </span>
                </div>
              </div>
              <button
                className="pill-btn full-width"
                onClick={() => setCurrentView('providers')}
              >
                Configure LLM Providers (12 available)
              </button>
            </CollapsibleSection>

            <CollapsibleSection title="Usage" defaultOpen>
              <div className="usage-stats">
                <div className="usage-stat">
                  <span className="usage-value">{chats.messageCountToday}</span>
                  <span className="usage-label">Messages sent today</span>
                </div>
                <div className="usage-stat">
                  <span className="usage-value">{serverHook.connectedServersCount}</span>
                  <span className="usage-label">MCP servers connected</span>
                </div>
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Working Directory" defaultOpen>
              <div className="global-directory-setting">
                <p className="settings-hint">Default working directory for new councils. Each council can override this in its Setup.</p>
                <div className="directory-input-row">
                  <input
                    type="text"
                    className="directory-input"
                    placeholder="/path/to/projects"
                    value={providerConfig.globalWorkingDirectory}
                    onChange={(e) => providerConfig.setGlobalWorkingDirectory(e.target.value)}
                  />
                  <button
                    type="button"
                    className="directory-browse-btn"
                    onClick={async () => {
                      try {
                        const selected = await tauriOpen({
                          directory: true,
                          multiple: false,
                          title: 'Select Default Working Directory',
                          defaultPath: providerConfig.globalWorkingDirectory || undefined,
                        });
                        if (selected && typeof selected === 'string') {
                          providerConfig.setGlobalWorkingDirectory(selected);
                        }
                      } catch (err) {
                        console.error('[Settings] Error selecting directory:', err);
                      }
                    }}
                  >
                    Browse...
                  </button>
                </div>
              </div>
            </CollapsibleSection>

{/* Billing section hidden for now
            <CollapsibleSection title="Billing" defaultOpen>
              <div className="billing-content">
                <div className="plan-options">
                  <PlanCard
                    label="Free"
                    price="Free"
                    desc="2 servers, 30 messages/day"
                    active={currentPlan === 'free'}
                    onSelect={() => setCurrentPlan('free')}
                  />
                  <PlanCard
                    label="Pro"
                    price="$2/month or $20/year"
                    desc="Unlimited servers and messages"
                    active={currentPlan === 'pro'}
                    onSelect={() => setCurrentPlan('pro')}
                  />
                  <PlanCard
                    label="Lifetime"
                    price="$99 one-time"
                    desc="Unlimited usage forever"
                    active={currentPlan === 'lifetime'}
                    onSelect={() => setCurrentPlan('lifetime')}
                  />
                </div>
              </div>
            </CollapsibleSection>
*/}

            <CollapsibleSection title="Updates" defaultOpen>
              <div className="updates-block">
                <p className="updates-message">
                  Current version: {APP_VERSION}
                  {updates.latestVersion ? ` • Latest: ${updates.latestVersion}` : ''}
                  {updates.updateAvailable && <span className="update-chip">Update available</span>}
                </p>
                <p className="updates-message">{updates.updateMessage}</p>
                <button className="pill-btn" onClick={updates.handleCheckUpdates} disabled={updates.updateStatus === 'checking'}>
                  {updates.updateStatus === 'checking' ? 'Checking…' : 'Verify updates'}
                </button>
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Appearance" defaultOpen>
              <div className="updates-block">
                <p className="updates-message">Choose your theme</p>
                <div className="theme-toggle">
                  <button
                    className={`pill-btn ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    Dark
                  </button>
                  <button
                    className={`pill-btn ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    Light
                  </button>
                </div>
              </div>
            </CollapsibleSection>
          </div>
        ) : (
          <ChatArea
            chatId={chats.currentChatId}
            messages={chats.chatMessages}
            onMessagesChange={(msgs) => chats.currentChatId && chats.handleChatMessagesChange(chats.currentChatId, msgs)}
            onChatUpdate={chats.handleChatMessagesChange}
            servers={serverHook.servers}
            availableTools={serverHook.availableTools}
            pendingToolInsert={chats.pendingToolInsert}
            onToolInsertHandled={() => chats.setPendingToolInsert(null)}
            apiKey={activeApiKey}
            anthropicKey={providerConfig.anthropicKey}
            openaiKey={providerConfig.openaiKey}
            provider={providerConfig.provider}
            openaiModel={providerConfig.openaiModel}
            anthropicModel={providerConfig.anthropicModel}
            chatModelId={providerConfig.chatModelId}
            discoveredOllamaModels={providerConfig.ollamaModels.length > 0 ? providerConfig.ollamaModels.map(m => ({
              id: m.id,
              name: m.name,
              provider: 'ollama' as const,
              contextWindow: 0,
              capabilities: ['text', 'code'],
              inputCostPer1K: 0,
              outputCostPer1K: 0,
              costDisplay: 'Free (local)',
              tier: 1 as const,
            })) : undefined}
            configuredProviders={providerConfig.configuredProviders}
            selectedProviderId={providerConfig.selectedProviderId}
            onProviderModelChange={providerConfig.handleProviderModelChange}
            globalWorkingDirectory={providerConfig.globalWorkingDirectory}
            chatWorkingDir={chats.chatWorkingDirs[chats.currentChatId || '']}
            onChatWorkingDirChange={(dir) => {
              if (chats.currentChatId) {
                chats.setChatWorkingDir(chats.currentChatId, dir);
              }
            }}
            chatModelPin={chats.chatModelPins[chats.currentChatId || ''] || null}
            onChatModelPinChange={(pin) => {
              if (chats.currentChatId) {
                chats.setChatModelPin(chats.currentChatId, pin);
              }
            }}
            sending={!!chats.chatsSending[chats.currentChatId || '']}
            onSendingChange={(v) => chats.currentChatId && chats.setChatSendingFor(chats.currentChatId, v)}
            activeProviderOverride={chats.chatsActiveProvider[chats.currentChatId || ''] ?? null}
            onActiveProviderChange={(v) => chats.currentChatId && chats.setChatActiveProviderFor(chats.currentChatId, v)}
            onChatSendingChange={chats.setChatSendingFor}
            onChatActiveProviderChange={chats.setChatActiveProviderFor}
          />
        )}
      </div>

      {chats.showNewChatDialog && (
        <NewChatDialog
          defaultDir={providerConfig.globalWorkingDirectory}
          onConfirm={chats.createNewChat}
          onCancel={chats.cancelNewChat}
        />
      )}

      {serverHook.pendingPermission && (
        <PermissionDialog
          message={serverHook.pendingPermission.message}
          operation={serverHook.pendingPermission.operation}
          onAllow={() => serverHook.resolvePermission('allow')}
          onAllowAll={() => serverHook.resolvePermission('allow-all')}
          onDeny={() => serverHook.resolvePermission('deny')}
        />
      )}

      {serverHook.showToolsPanel && (
        <ToolsPanel
          className="tools-drawer"
          onClose={() => serverHook.setShowToolsPanel(false)}
          servers={serverHook.servers}
          onServerConnect={serverHook.handleConnectServer}
          onServerReconnect={serverHook.handleReconnectServer}
          onServerDisconnect={serverHook.handleDisconnectServer}
          onServerDelete={serverHook.handleDeleteServer}
          onServerUpdate={serverHook.handleUpdateServer}
          onServerReauthenticate={serverHook.handleReauthenticateServer}
          onServerAddLocal={serverHook.handleServerAddLocal}
          onGithubCheck={chats.handleGithubCheck}
          connectDeadlines={serverHook.connectDeadlines}
          onToolClick={(toolName) => {
            chats.setPendingToolInsert(toolName);
            setCurrentView('chat');
          }}
        />
      )}
    </div>
  );
}

export default App;
