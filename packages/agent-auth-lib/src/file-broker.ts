import { readFile, stat } from 'node:fs/promises';
import type { Credential, CredentialBroker, Provider } from './types.ts';

interface ProviderEntry {
  apiKey: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

interface AuthFile {
  version: 1;
  providers: Record<string, ProviderEntry>;
}

/**
 * v1 trust model (decision #5): file at `~/.<your-org>/auth.json`, mode 0600.
 * The file-perm check is the entire auth boundary — there is no app-level auth
 * in v1. Every other gate (UDS sockets, capture redaction) layers on top.
 */
export class FileBroker implements CredentialBroker {
  constructor(private readonly path: string) {}

  async getCredential(provider: Provider): Promise<Credential> {
    await this.assertSecurePermissions();
    const raw = await readFile(this.path, 'utf8');
    const parsed = JSON.parse(raw) as AuthFile;
    const entry = parsed.providers[provider];
    if (!entry) {
      throw new Error(`Provider not configured in ${this.path}: ${provider}`);
    }
    if (entry.apiKey.includes('REPLACE_ME')) {
      throw new Error(
        `Provider ${provider} still holds the placeholder credential. ` +
          (provider === 'github-copilot'
            ? `Run: pnpm harness auth login github-copilot`
            : `Edit ${this.path} and paste a real key.`),
      );
    }
    return {
      provider,
      apiKey: entry.apiKey,
      expiresAt: entry.expiresAt,
      tokenType: entry.tokenType,
      scope: entry.scope,
      source: 'host-file',
    };
  }

  private async assertSecurePermissions(): Promise<void> {
    const info = await stat(this.path);
    const mode = info.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `${this.path} has mode 0${mode.toString(8)}; required 0600. ` +
          `Run: chmod 600 ${this.path}`,
      );
    }
  }
}
