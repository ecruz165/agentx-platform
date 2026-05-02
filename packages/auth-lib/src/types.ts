/**
 * Credential issuer (the upstream that minted the API key or OAuth token).
 * NOT the adapter type — an OpenCode CLI adapter running Claude under the hood
 * still needs an `anthropic` credential, not an "opencode" one.
 *
 * Resolves review-G drift across auth-lib / agent-adapter / harness-core PRDs.
 */
export type Provider = 'anthropic' | 'openai' | 'google' | 'github-copilot';

export interface Credential {
  provider: Provider;
  apiKey: string;
  expiresAt?: string;
  source: 'host-file' | 'uds-broker' | 'env';
  /**
   * OAuth-acquired credentials carry the token type ('Bearer') and scope so
   * downstream consumers (or refresh logic) can act on them. Long-lived API
   * keys leave these undefined.
   */
  tokenType?: string;
  scope?: string;
}

export interface CredentialBroker {
  getCredential(provider: Provider): Promise<Credential>;
  refresh?(provider: Provider): Promise<Credential>;
}
