import { useState, useEffect } from 'react';
import Sidebar, { type AppView } from './components/Sidebar';
import ChatArea from './components/ChatArea';
import { PipelineLibrary, PipelineBuilder, PipelineExecutionView } from './components/pipeline';
import { requestPipelineCreate } from './components/pipeline/pipelineCreateSignal';
import { COUNCIL_RUN_EVENT } from './components/council/councilCreateSignal';
import { requestCouncilView } from './components/council/councilSetupSignal';
import ErrorBoundary from './components/ErrorBoundary';
import ProjectView from './components/ProjectView';
import { createDefaultCouncil } from './council/createDefaultCouncil';
import { useActiveSetupSection } from './components/council/setupDetailStore';
import { CouncilLibrary, CouncilView } from './components/council';
import NewChatDialog from './components/NewChatDialog';
import PermissionDialog from './components/PermissionDialog';
import SettingsModal from './components/SettingsModal';
import RightSidebar from './components/RightSidebar';
import './services/appearanceStore'; // applies saved font-size CSS vars on load
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
  // Non-null while a council's setup/edit form is open — hides the workspace panel.
  const editingCouncilSetup = useActiveSetupSection();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  // Set when a council was opened FROM the pipeline graph (⚖ deliberation) —
  // Back returns to the pipeline builder instead of the council library.
  const [councilFromPipeline, setCouncilFromPipeline] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

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
    selectedProviderId: providerConfig.selectedProviderId,
    openaiKey: providerConfig.openaiKey,
    anthropicKey: providerConfig.anthropicKey,
    openaiModel: providerConfig.openaiModel,
    anthropicModel: providerConfig.anthropicModel,
    globalWorkingDirectory: providerConfig.globalWorkingDirectory,
  });
  const council = useCouncilHandlers({
    availableTools: serverHook.availableTools,
    configuredProviders: providerConfig.configuredProviders,
  });
  const pipeline = usePipeline({
    availableTools: serverHook.availableTools,
    setThinkingPersonas: council.setThinkingPersonas,
    configuredProviders: providerConfig.configuredProviders,
  });

  const activeApiKey = providerConfig.provider === 'chatgpt' ? providerConfig.openaiKey : providerConfig.anthropicKey;

  // Chat → council: when ChatArea generates a council it dispatches this event;
  // navigate to the council view (which auto-runs the pending deliberation).
  useEffect(() => {
    const onRun = (e: Event) => {
      const id = (e as CustomEvent).detail?.councilId;
      if (id) { council.setCurrentCouncilId(id); setCurrentView('council'); }
    };
    window.addEventListener(COUNCIL_RUN_EVENT, onRun);
    return () => window.removeEventListener(COUNCIL_RUN_EVENT, onRun);
  }, [council]);

  return (
    <div className="app-container">
      <Sidebar
        className="sidebar-drawer"
        currentView={currentView}
        onViewChange={(v) => { setCouncilFromPipeline(false); setCurrentView(v); }}
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
        currentCouncilId={council.currentCouncilId}
        onCouncilSelect={(id) => { setCouncilFromPipeline(false); council.setCurrentCouncilId(id); setCurrentView('council'); }}
        onNewCouncil={() => { council.setCurrentCouncilId(null); setCurrentView('council'); }}
        onShowCouncilLibrary={() => { council.setCurrentCouncilId(null); setCurrentView('council'); }}
        currentProjectId={currentProjectId}
        onSelectProject={(id) => { setCurrentProjectId(id); setCurrentView('project'); }}
        currentPipelineId={pipeline.currentPipelineId}
        onPipelineSelect={(id) => { pipeline.handlePipelineSelect(id); setCurrentView('pipelines'); }}
        onShowPipelineLibrary={() => { pipeline.handlePipelineBack(); setCurrentView('pipelines'); }}
        onNewPipeline={() => { pipeline.handlePipelineBack(); requestPipelineCreate(); setCurrentView('pipelines'); }}
        providerErrorCount={providerConfig.validationReport?.llmProviders.filter(r => r.status === 'error').length || 0}
        providerExpiredCount={providerConfig.providersList.filter(p => p.oauthExpired).length}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <div className="main-column">
        <ErrorBoundary
          label="this view"
          resetKey={`${currentView}:${pipeline.currentPipelineId ?? ''}:${council.currentCouncilId ?? ''}`}
        >
        {currentView === 'project' && currentProjectId ? (
          <ProjectView
            projectId={currentProjectId}
            chats={chats.sidebarChats.map((c) => ({ id: c.id, title: c.title }))}
            onOpenCouncil={(id) => { council.setCurrentCouncilId(id); setCurrentView('council'); }}
            onOpenChat={(id) => { chats.setCurrentChatId(id); setCurrentView('chat'); }}
            onNewChat={() => chats.createNewChat('')}
            onNewCouncil={() => {
              const c = createDefaultCouncil({
                configuredProviders: providerConfig.configuredProviders,
                workingDirectory: providerConfig.globalWorkingDirectory,
              });
              council.setCurrentCouncilId(c.id);
              setCurrentView('council');
              return c.id;
            }}
          />
        ) : currentView === 'pipelines' ? (
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
              onOpenCouncil={(councilId) => {
                requestCouncilView(councilId);
                council.setCurrentCouncilId(councilId);
                setCouncilFromPipeline(true);
                setCurrentView('council');
              }}
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
              onBack={() => {
                if (councilFromPipeline) {
                  // Came from the pipeline graph — return to the builder.
                  setCouncilFromPipeline(false);
                  setCurrentView('pipelines');
                } else {
                  council.setCurrentCouncilId(null);
                }
              }}
              onSelectCouncil={(id) => council.setCurrentCouncilId(id)}
              onGenerateTurn={council.onGenerateTurn}
              onGenerateRound={council.onGenerateRound}
              onGenerateSynthesis={council.onGenerateSynthesis}
              onResolve={council.onResolve}
              onFrameProblem={council.onFrameProblem}
              onRunWorkflow={pipeline.runCouncilWorkflow}
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
        ) : (
          <ChatArea
            chatId={chats.currentChatId}
            messages={chats.chatMessages}
            onMessagesChange={(msgs) => chats.currentChatId && chats.handleChatMessagesChange(chats.currentChatId, msgs)}
            onChatUpdate={chats.handleChatMessagesChange}
            onDeleteChat={chats.handleDeleteChat}
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
            showRightSidebar={showRightSidebar}
            onToggleRightSidebar={() => setShowRightSidebar(!showRightSidebar)}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}
        </ErrorBoundary>
      </div>

      {/* The Workspace panel is shared by chat and council. In council view it
          keeps Files/Artifacts/Tasks/Review/Context. It's hidden while editing a
          council's setup (the setup/edit screen is self-contained and full-width). */}
      {(currentView === 'chat' || (currentView === 'council' && council.currentCouncilId && !editingCouncilSetup)) && (
        <RightSidebar
          workingDirectory={providerConfig.globalWorkingDirectory}
          chatWorkingDir={chats.chatWorkingDirs[chats.currentChatId || ''] || null}
          councilId={currentView === 'council' ? council.currentCouncilId : null}
          isOpen={showRightSidebar}
          onToggle={() => setShowRightSidebar(!showRightSidebar)}
        />
      )}

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


      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        theme={theme}
        setTheme={setTheme}
        globalWorkingDirectory={providerConfig.globalWorkingDirectory}
        setGlobalWorkingDirectory={providerConfig.setGlobalWorkingDirectory}
        messageCountToday={chats.messageCountToday}
        providersList={providerConfig.providersList}
        selectedProviderId={providerConfig.selectedProviderId}
        anthropicModel={providerConfig.anthropicModel}
        openaiModel={providerConfig.openaiModel}
        chatModelId={providerConfig.chatModelId}
        handleProviderUpdate={providerConfig.handleProviderUpdate}
        handleDefaultChange={providerConfig.handleDefaultChange}
        handleValidateCredentials={providerConfig.handleValidateCredentials}
        handleRefreshStatus={providerConfig.handleRefreshStatus}
        handleAuthMethodChange={providerConfig.handleAuthMethodChange}
        handleDisconnectOAuth={providerConfig.handleDisconnectOAuth}
        handleStartOAuthLogin={providerConfig.handleStartOAuthLogin}
        handleCodexLogin={providerConfig.handleCodexLogin}
        isCodexLoggingIn={providerConfig.isCodexLoggingIn}
        configuredProvidersCount={Object.values(providerConfig.configuredProviders).filter(Boolean).length}
        servers={serverHook.servers}
        connectedServersCount={serverHook.connectedServersCount}
        connectDeadlines={serverHook.connectDeadlines}
        handleConnectServer={serverHook.handleConnectServer}
        handleReconnectServer={serverHook.handleReconnectServer}
        handleDisconnectServer={serverHook.handleDisconnectServer}
        handleDeleteServer={serverHook.handleDeleteServer}
        handleUpdateServer={serverHook.handleUpdateServer}
        handleReauthenticateServer={serverHook.handleReauthenticateServer}
        handleServerAddLocal={serverHook.handleServerAddLocal}
        handleSearchServiceStatusChange={serverHook.handleSearchServiceStatusChange}
        handleGithubCheck={chats.handleGithubCheck}
        onToolClick={(toolName) => {
          chats.setPendingToolInsert(toolName);
          setCurrentView('chat');
        }}
        updates={updates}
        appVersion={APP_VERSION}
      />
    </div>
  );
}

export default App;
