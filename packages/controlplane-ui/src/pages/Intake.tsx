import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Code,
  Divider,
  Input,
  Spinner,
  Textarea,
} from "@heroui/react";
import { intent, IntentSession, subscribeToSession } from "../lib/api";

interface ChatLine {
  who: "user" | "system";
  text: string;
  at: string;
}

/**
 * Phase 6 — chat-style consumer of the Intent SSE stream. Demonstrates
 * the full intake → confirm round-trip without depending on a real
 * intake pipeline (the backend just needs the user to start a session
 * with any registered job-definition flow).
 *
 * <p>Three states drive the UI:
 *  - no session: prompt for intakePipelineId + productId, then start
 *  - session active: show chat log + SSE-streamed events
 *  - intent-ready: confirmation card with the resolved intent
 */
export default function IntakePage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();

  const [session, setSession] = useState<IntentSession | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state for "start session"
  const [pipelineId, setPipelineId] = useState("default-intake");
  const [productId, setProductId] = useState("demo-product");
  const [initial, setInitial] = useState("");

  const cleanupRef = useRef<(() => void) | null>(null);

  // Resume on URL change / mount: if sessionId in URL, fetch + subscribe.
  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setLines([]);
      cleanupRef.current?.();
      cleanupRef.current = null;
      return;
    }
    let cancelled = false;
    setPending(true);
    intent
      .get(sessionId)
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setLines([
          {
            who: "system",
            text: `session ${s.id} (status=${s.status})`,
            at: s.createdAt,
          },
        ]);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setPending(false));

    const cleanup = subscribeToSession(sessionId, {
      onAny: (kind, data) => {
        setLines((prev) => [
          ...prev,
          {
            who: "system",
            text: `event:${kind} ${JSON.stringify(data)}`,
            at: new Date().toISOString(),
          },
        ]);
      },
      onIntentReady: () => {
        intent.get(sessionId).then(setSession).catch(() => {});
      },
      onJobSubmitted: () => {
        intent.get(sessionId).then(setSession).catch(() => {});
      },
      onAborted: () => {
        intent.get(sessionId).then(setSession).catch(() => {});
      },
    });
    cleanupRef.current = cleanup;
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [sessionId]);

  async function startSession() {
    setError(null);
    setPending(true);
    try {
      const s = await intent.start({
        intakePipelineId: pipelineId || undefined,
        productId: productId || undefined,
        initialInput: initial ? safeJson(initial) ?? { message: initial } : undefined,
      });
      navigate(`/intake/${s.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  async function sendMessage(message: string) {
    if (!session) return;
    setLines((prev) => [
      ...prev,
      { who: "user", text: message, at: new Date().toISOString() },
    ]);
    try {
      await intent.message(session.id, message);
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirmAndRun() {
    if (!session?.resolvedIntent) return;
    const intentBody = session.resolvedIntent as {
      flowId: string;
      productId: string;
      input?: unknown;
    };
    try {
      const updated = await intent.confirm(session.id, intentBody);
      setSession(updated);
    } catch (e) {
      setError(String(e));
    }
  }

  async function abortSession() {
    if (!session) return;
    try {
      const updated = await intent.abort(session.id);
      setSession(updated);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!sessionId) {
    return (
      <Card className="max-w-xl mx-auto">
        <CardHeader>
          <div className="flex flex-col">
            <p className="text-md">Start an intake session</p>
            <p className="text-sm text-default-500">
              Submits a job-definition pipeline and tracks it through{" "}
              <Code size="sm">intent-ready</Code>.
            </p>
          </div>
        </CardHeader>
        <Divider />
        <CardBody className="gap-3">
          <Input
            label="Intake pipeline id"
            placeholder="default-intake"
            value={pipelineId}
            onValueChange={setPipelineId}
          />
          <Input
            label="Product id"
            placeholder="demo-product"
            value={productId}
            onValueChange={setProductId}
          />
          <Textarea
            label="Initial input (JSON or plain message)"
            placeholder='{"goal":"upgrade React"}'
            value={initial}
            onValueChange={setInitial}
            minRows={3}
          />
          {error && <Code color="danger">{error}</Code>}
          <Button
            color="primary"
            onPress={startSession}
            isLoading={pending}
            isDisabled={!pipelineId || !productId}
          >
            Start session
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card className="md:col-span-2">
        <CardHeader className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="text-sm text-default-500">session</span>
            <Code size="sm">{sessionId.slice(0, 8)}…</Code>
            {session && <StatusChip status={session.status} />}
          </div>
          <Button size="sm" variant="flat" onPress={() => navigate("/intake")}>
            New session
          </Button>
        </CardHeader>
        <Divider />
        <CardBody>
          {pending && !session && <Spinner label="Loading session…" />}
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {lines.map((l, i) => (
              <div
                key={i}
                className={
                  "p-2 rounded-md text-sm " +
                  (l.who === "user"
                    ? "bg-primary-100/30 ml-12"
                    : "bg-default-100 mr-12 font-mono text-xs")
                }
              >
                {l.text}
              </div>
            ))}
          </div>
          <Divider className="my-3" />
          <MessageBar
            disabled={
              !session ||
              session.status === "aborted" ||
              session.status === "submitted" ||
              session.status === "expired"
            }
            onSend={sendMessage}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <p className="text-md">Session detail</p>
        </CardHeader>
        <Divider />
        <CardBody className="gap-3">
          {error && <Code color="danger">{error}</Code>}
          {session && (
            <>
              <DetailRow label="status" value={<StatusChip status={session.status} />} />
              <DetailRow
                label="intake job"
                value={<Code size="sm">{session.intakeJobId ?? "—"}</Code>}
              />
              {session.workJobId && (
                <DetailRow
                  label="work job"
                  value={<Code size="sm">{session.workJobId}</Code>}
                />
              )}
              {session.resolvedIntent && (
                <div>
                  <p className="text-xs text-default-500 mb-1">resolved intent</p>
                  <pre className="text-xs bg-default-100 p-2 rounded overflow-x-auto">
                    {JSON.stringify(session.resolvedIntent, null, 2)}
                  </pre>
                </div>
              )}
              <Divider />
              <div className="flex flex-col gap-2">
                {session.status === "intent-ready" && (
                  <Button color="success" onPress={confirmAndRun}>
                    Confirm & run
                  </Button>
                )}
                {session.status !== "submitted" &&
                  session.status !== "aborted" &&
                  session.status !== "expired" && (
                    <Button color="danger" variant="flat" onPress={abortSession}>
                      Abort session
                    </Button>
                  )}
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function MessageBar({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex gap-2">
      <Input
        placeholder="Type a message…"
        value={text}
        onValueChange={setText}
        isDisabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text && !disabled) {
            onSend(text);
            setText("");
          }
        }}
      />
      <Button
        color="primary"
        isDisabled={disabled || !text}
        onPress={() => {
          if (text) {
            onSend(text);
            setText("");
          }
        }}
      >
        Send
      </Button>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-default-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StatusChip({ status }: { status: IntentSession["status"] }) {
  const tone =
    status === "submitted" ? "success" :
    status === "intent-ready" ? "primary" :
    status === "aborted" || status === "failed" || status === "expired" ? "danger" :
    "default";
  return (
    <Chip size="sm" color={tone} variant="flat">
      {status}
    </Chip>
  );
}

function safeJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
