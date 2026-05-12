export { type AuthFile, AuthStore, type ProviderEntry, type ProviderStatus } from './auth-store.ts';
export {
  BindingResolutionError,
  type BindingResolver,
  DefaultBindingResolver,
  type ResolvedBinding,
  resolveAllBindingsFor,
  resolveBindingFor,
} from './binding-resolver.ts';
export {
  type ChatCompletionResponse,
  type ChatMessage,
  callCopilot,
  fetchGitHubUsername,
  getCopilotSessionToken,
} from './copilot-api.ts';
export { FileBroker } from './file-broker.ts';
export {
  ChainedGitHubResolver,
  ControlplaneGitHubResolver,
  defaultGitHubResolver,
  type GitHubCredential,
  GitHubCredentialError,
  type GitHubCredentialResolver,
  type GitHubCredentialSource,
  type GitHubRepoRef,
  LocalAmbientGitHubResolver,
} from './github-creds.ts';
export {
  type DeviceFlowOptions,
  type DeviceFlowResult,
  loginGitHubCopilot,
} from './github-device-flow.ts';
export type {
  AuthMethod,
  LLMProvider,
  ModelDescriptor,
  ModelType,
  ResolvedRegistryEntry,
  ToolId,
} from './llm-provider.ts';
export {
  BUILT_IN_PROVIDERS,
  findBinding,
  findProvider,
} from './provider-registry.ts';
export type { Credential, CredentialBroker, Provider } from './types.ts';
