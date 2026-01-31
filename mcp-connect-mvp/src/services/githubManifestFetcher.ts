import { invoke } from '@tauri-apps/api/core';

export interface GithubManifestRequest {
  repoUrl: string;
  reference?: string;
  manifestPath?: string;
}

export interface GithubManifestResult {
  manifest: any;
  raw: string;
}

export async function fetchGithubManifest(req: GithubManifestRequest): Promise<GithubManifestResult> {
  const raw = await invoke<string>('fetch_github_manifest', {
    request: {
      repo_url: req.repoUrl,
      reference: req.reference,
      manifest_path: req.manifestPath,
    },
  });
  const manifest = JSON.parse(raw);
  return { manifest, raw };
}

export async function fetchGithubReadme(repoUrl: string, reference?: string): Promise<string> {
  return invoke<string>('fetch_github_readme', {
    request: {
      repo_url: repoUrl,
      reference,
    },
  });
}
