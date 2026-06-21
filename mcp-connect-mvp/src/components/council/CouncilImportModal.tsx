/**
 * CouncilImportModal — discover and import councils that were run via the CLI
 * (`npm run council`) so their results are browsable in the UI.
 */
import { useEffect, useState, type FC } from 'react';
import { discoverCliCouncilSessions, importCliCouncilSession, type CliCouncilSummary } from '../../council/session-import';
import './CouncilImportModal.css';

const CouncilImportModal: FC<{ onClose: () => void; onImported: (councilId: string) => void }> = ({ onClose, onImported }) => {
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CliCouncilSummary[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setSessions(await discoverCliCouncilSessions());
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleImport = async (s: CliCouncilSummary) => {
    setImporting(s.filePath);
    setError(null);
    try {
      const id = await importCliCouncilSession(s.filePath);
      onImported(id);
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="council-import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ci-head">
          <h2>Import CLI councils</h2>
          <button className="setup-dialog-close" onClick={onClose}>×</button>
        </div>
        <p className="ci-sub">Councils run with <code>npm run council</code> export a session to Kondi's data directory. Import one to view its deliberation and results here.</p>
        {error && <div className="ci-error">{error}</div>}
        {loading ? (
          <div className="ci-empty">Scanning for sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="ci-empty">No CLI council sessions found.</div>
        ) : (
          <div className="ci-list">
            {sessions.map((s) => (
              <div key={s.filePath} className="ci-row">
                <div className="ci-info">
                  <div className="ci-name">{s.councilName}{s.alreadyImported && <span className="ci-tag">imported</span>}</div>
                  <div className="ci-meta">{s.status} · {s.entryCount} entries · {new Date(s.exportedAt).toLocaleString()}</div>
                </div>
                <button className="ci-import-btn" disabled={importing === s.filePath} onClick={() => handleImport(s)}>
                  {importing === s.filePath ? 'Importing…' : s.alreadyImported ? 'Re-import' : 'Import'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CouncilImportModal;
