export interface CaptureEvent {
  ts: string;
  kind: 'request' | 'response' | 'error';
  payload: unknown;
}

export interface CaptureSink {
  write(event: CaptureEvent): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  invoke(prompt: string): Promise<string>;
}
