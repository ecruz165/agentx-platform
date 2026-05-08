import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Accordion,
  AccordionItem,
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Code,
  Divider,
  Spinner,
} from "@heroui/react";
import { Job, jobs } from "../lib/api";

/**
 * Per-input drill-down for a benchmark run. Lists jobs in the cohort
 * with status, score, and a collapsible accordion showing input /
 * output / rationale for each. Used by clicking through from
 * /benchmarks → "View jobs."
 */
export default function BenchmarkRunPage() {
  const { runId } = useParams<{ runId: string }>();

  const { data, isPending, error } = useQuery({
    queryKey: ["benchmark-run", runId],
    queryFn: () => jobs.listByBenchmarkRun(runId!),
    enabled: !!runId,
    refetchInterval: 5_000,
  });

  if (!runId) return null;
  if (isPending) return <Spinner label="Loading jobs…" />;
  if (error) return <Code color="danger">{String(error)}</Code>;
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-default-500">No jobs found for run {runId}.</p>
        </CardBody>
      </Card>
    );
  }

  const label = data[0]?.benchmarkLabel;
  const counts = countByStatus(data);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex justify-between items-start gap-3">
          <div className="flex flex-col gap-1">
            <Code size="sm">{runId}</Code>
            {label && <p className="text-sm font-semibold">{label}</p>}
            <p className="text-xs text-default-500">
              {data.length} job(s) · {counts.completed} completed · {counts.failed} failed ·{" "}
              {counts.inFlight} in-flight
            </p>
          </div>
          <Button as={Link} to={`/benchmarks?runIds=${runId}`} variant="flat" size="sm">
            ← back to compare
          </Button>
        </CardHeader>
      </Card>

      <Accordion variant="splitted" selectionMode="multiple">
        {data.map((job, idx) => (
          <AccordionItem
            key={job.id}
            aria-label={`job ${idx + 1}`}
            title={<JobRowTitle job={job} index={idx + 1} />}
            subtitle={
              <span className="text-xs text-default-500 font-mono">
                {job.id.slice(0, 24)}…
              </span>
            }
          >
            <JobDetail job={job} />
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

function JobRowTitle({ job, index }: { job: Job; index: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-default-500 text-sm w-8">#{index}</span>
      <Chip size="sm" color={statusColor(job.status)} variant="flat">
        {job.status}
      </Chip>
      <ScoreChip score={job.evalScore} />
      <span className="text-sm text-default-700 truncate max-w-md">
        {summarizeInput(job.input)}
      </span>
    </div>
  );
}

function JobDetail({ job }: { job: Job }) {
  const [showFullInput, setShowFullInput] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);

  return (
    <div className="space-y-3 text-sm">
      <Section label="status" value={job.status} />
      {job.benchmarkLabel && <Section label="label" value={job.benchmarkLabel} />}
      {job.failureReason && <Section label="failureReason" value={job.failureReason} />}

      <Divider />

      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <span className="text-default-500">input</span>
          <Button
            size="sm"
            variant="light"
            onPress={() => setShowFullInput((s) => !s)}
          >
            {showFullInput ? "collapse" : "expand"}
          </Button>
        </div>
        <pre className="text-xs bg-default-100 p-2 rounded max-h-96 overflow-auto">
          {showFullInput
            ? JSON.stringify(job.input, null, 2)
            : truncate(JSON.stringify(job.input, null, 2), 240)}
        </pre>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <span className="text-default-500">output</span>
          <Button
            size="sm"
            variant="light"
            onPress={() => setShowFullOutput((s) => !s)}
          >
            {showFullOutput ? "collapse" : "expand"}
          </Button>
        </div>
        <pre className="text-xs bg-default-100 p-2 rounded max-h-96 overflow-auto">
          {job.output == null
            ? "(no output yet)"
            : showFullOutput
              ? JSON.stringify(job.output, null, 2)
              : truncate(JSON.stringify(job.output, null, 2), 240)}
        </pre>
      </div>

      {(job.evalScore != null || job.evalRationale) && (
        <>
          <Divider />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-default-500">score</span>
              <ScoreChip score={job.evalScore} />
              {job.evalJudge && (
                <Chip size="sm" variant="flat">
                  judge: {job.evalJudge}
                </Chip>
              )}
            </div>
            {job.evalRationale && (
              <p className="text-default-700 text-xs">{job.evalRationale}</p>
            )}
          </div>
        </>
      )}

      <Divider />

      <div className="flex gap-3 text-xs text-default-500">
        <span>created {fmt(job.createdAt)}</span>
        {job.startedAt && <span>started {fmt(job.startedAt)}</span>}
        {job.completedAt && <span>completed {fmt(job.completedAt)}</span>}
      </div>
    </div>
  );
}

function Section({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-default-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ScoreChip({ score }: { score?: number | null }) {
  if (score == null) {
    return (
      <Chip size="sm" variant="flat">
        unscored
      </Chip>
    );
  }
  const tone = score >= 0.7 ? "success" : score >= 0.3 ? "warning" : "danger";
  return (
    <Chip size="sm" color={tone} variant="flat">
      {score.toFixed(2)}
    </Chip>
  );
}

function statusColor(status: Job["status"]) {
  return status === "completed"
    ? "success"
    : status === "failed" || status === "cancelled"
      ? "danger"
      : status === "running"
        ? "primary"
        : "default";
}

function summarizeInput(input: unknown): string {
  if (input == null) return "(no input)";
  if (typeof input === "string") return truncate(input, 100);
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.prompt === "string") return truncate(o.prompt, 100);
    if (typeof o.text === "string") return truncate(o.text, 100);
    return truncate(JSON.stringify(input), 100);
  }
  return String(input);
}

function countByStatus(rows: Job[]) {
  let completed = 0,
    failed = 0,
    inFlight = 0;
  for (const j of rows) {
    if (j.status === "completed") completed += 1;
    else if (j.status === "failed" || j.status === "cancelled") failed += 1;
    else inFlight += 1;
  }
  return { completed, failed, inFlight };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}
