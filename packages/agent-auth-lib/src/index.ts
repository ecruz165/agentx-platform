export type { Credential, CredentialBroker, Provider } from './types.ts';
export { FileBroker } from './file-broker.ts';
export { AuthStore, type AuthFile, type ProviderEntry, type ProviderStatus } from './auth-store.ts';
export { loginGitHubCopilot, type DeviceFlowOptions, type DeviceFlowResult } from './github-device-flow.ts';
export {
  callCopilot,
  getCopilotSessionToken,
  fetchGitHubUsername,
  type ChatMessage,
  type ChatCompletionResponse,
} from './copilot-api.ts';
export type {
  AuthMethod,
  ModelType,
  ModelDescriptor,
  LLMProvider,
  ResolvedRegistryEntry,
} from './llm-provider.ts';
export {
  BUILT_IN_PROVIDERS,
  findProvider,
  findBinding,
} from './provider-registry.ts';
export {
  BindingResolutionError,
  DefaultBindingResolver,
  resolveBindingFor,
  type BindingResolver,
  type ResolvedBinding,
} from './binding-resolver.ts';
