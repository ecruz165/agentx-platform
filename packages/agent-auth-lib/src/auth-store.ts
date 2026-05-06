import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Provider } from './types.ts';

export interface ProviderEntry {
  apiKey: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
  createdAt?: string;
  // Copilot-specific lazy cache fields (populated by getCopilotSessionToken).
  // Stored at this layer so refresh logic can read/write without touching the
  // Credential interface that agent code sees.
  copilotToken?: string;
  copilotTokenExpiresAt?: number;
  username?: string;
}

export interface AuthFile {
  version: 1;
  providers: Record<string, ProviderEntry>;
}

export interface ProviderStatus {
  configured: boolean;
  authenticated: boolean;
  tokenLength?: number;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
  createdAt?: string;
  username?: string;
  hasCopilotSessionToken?: boolean;
  copilotSessionExpiresIn?: number;
}

/**
 * Reads + writes the auth.json file. Used by the CLI's `harness auth` flow.
 * Always writes mode 0600 (decision #5). Never logs or returns the apiKey
 * value from `status()` — only metadata.
 */
export class AuthStore {
  constructor(private readonly path: string) {}

  async read(): Promise<AuthFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as AuthFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, providers: {} };
      }
      throw err;
    }
  }

  async write(file: AuthFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async setProvider(provider: Provider, entry: ProviderEntry): Promise<void> {
    const file = await this.read();
    file.providers[provider] = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString() };
    await this.write(file);
  }

  async removeProvider(provider: Provider): Promise<boolean> {
    const file = await this.read();
    if (!(provider in file.providers)) return false;
    delete file.providers[provider];
    await this.write(file);
    return true;
  }

  async status(): Promise<Record<string, ProviderStatus>> {
    const file = await this.read();
    const nowSec = Math.floor(Date.now() / 1000);
    const out: Record<string, ProviderStatus> = {};
    for (const [provider, entry] of Object.entries(file.providers)) {
      const isPlaceholder = entry.apiKey.includes('REPLACE_ME');
      out[provider] = {
        configured: true,
        authenticated: !isPlaceholder,
        tokenLength: isPlaceholder ? undefined : entry.apiKey.length,
        expiresAt: entry.expiresAt,
        tokenType: entry.tokenType,
        scope: entry.scope,
        createdAt: entry.createdAt,
        username: entry.username,
        hasCopilotSessionToken: !!entry.copilotToken,
        copilotSessionExpiresIn: entry.copilotTokenExpiresAt
          ? entry.copilotTokenExpiresAt - nowSec
          : undefined,
      };
    }
    return out;
  }
}
