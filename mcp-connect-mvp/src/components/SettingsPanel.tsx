import { useState, type FC } from 'react';
import { openaiClient } from '../services/openaiClient';

export const SettingsPanel: FC = () => {
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    openaiClient.setApiKey(apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="p-4 bg-gray-100 border-b">
      <h2 className="text-lg font-bold mb-2">Settings</h2>
      <div className="flex gap-2">
        <input
          type="password"
          placeholder="OpenAI API Key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="flex-1 px-3 py-2 border rounded"
        />
        <button
          onClick={handleSave}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Save
        </button>
      </div>
      {saved && (
        <p className="text-green-600 text-sm mt-1">API key saved!</p>
      )}
    </div>
  );
};
