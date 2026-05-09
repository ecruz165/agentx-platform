import { useState, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { benchmarks, BenchmarkRunSummary } from "../lib/api";

/**
 * Benchmark compare page. URL drives state — ?runIds=A,B,C lets users
 * share a comparison. Renders a summary table + side-by-side bar
 * charts for the metrics that matter (success rate, avg score,
 * latency).
 */
export default function BenchmarksPage() {
  const [params, setParams] = useSearchParams();
  const runIdsParam = params.get("runIds") ?? "";
  const runIds = useMemo(
    () => runIdsParam.split(",").map((s) => s.trim()).filter(Boolean),
    [runIdsParam],
  );

  const [draft, setDraft] = useState(runIdsParam);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["benchmarks-compare", runIds.join(",")],
    queryFn: () => benchmarks.compare(runIds),
    enabled: runIds.length > 0,
    refetchInterval: 5_000,
  });

  function applyDraft() {
    setParams({ runIds: draft });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-1 items-start">
          <p className="text-md font-semibold">Benchmark compare</p>
          <p className="text-sm text-default-500">
            Paste comma-separated run IDs (returned by{" "}
            <Code size="sm">workspace bench run</Code>); auto-refresh every 5s.
          </p>
        </CardHeader>
        <Divider />
        <CardBody className="flex flex-row gap-2 items-end">
          <Input
            label="Run IDs"
            placeholder="run-abc,run-def"
            value={draft}
            onValueChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyDraft();
            }}
          />
          <Button color="primary" onPress={applyDraft} isDisabled={!draft.trim()}>
            Compare
          </Button>
          <Button variant="flat" onPress={() => refetch()} isDisabled={runIds.length === 0}>
            Refresh
          </Button>
        </CardBody>
      </Card>

      {isPending && runIds.length > 0 && <Spinner label="Loading benchmark data…" />}
      {error && <Code color="danger">{String(error)}</Code>}
      {data && data.length > 0 && <CompareView rows={data} />}
      {data && data.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-default-500">No matching runs found.</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function CompareView({ rows }: { rows: BenchmarkRunSummary[] }) {
  // Color cycle for the bars per run — Hero UI's Tailwind palette.
  const colors = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#0ea5e9"];

  // Build chart data: one row per metric, columns per run.
  const metricChart = [
    {
      metric: "success rate",
      ...rowsByLabel(rows, (r) => r.successRate),
    },
    {
      metric: "avg score",
      ...rowsByLabel(rows, (r) => r.avgScore ?? 0),
    },
  ];

  const latencyChart = [
    {
      metric: "p50 (ms)",
      ...rowsByLabel(rows, (r) => r.p50LatencyMs),
    },
    {
      metric: "p95 (ms)",
      ...rowsByLabel(rows, (r) => r.p95LatencyMs),
    },
  ];

  // Estimation: MAE is always >=0, bias is signed. Both share the
  // story-point unit so they belong on the same axis.
  const anyEstimated = rows.some((r) => r.estimated > 0);
  const estimationChart = [
    {
      metric: "MAE (pts)",
      ...rowsByLabel(rows, (r) => r.meanAbsError ?? 0),
    },
    {
      metric: "bias (pts)",
      ...rowsByLabel(rows, (r) => r.bias ?? 0),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Side-by-side cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map((r, idx) => (
          <Card key={r.runId}>
            <CardHeader className="flex justify-between items-start gap-2">
              <div className="flex flex-col items-start gap-0">
                <Code size="sm" className="text-xs">
                  {r.runId.length > 24 ? `${r.runId.slice(0, 24)}…` : r.runId}
                </Code>
                <p
                  className="text-sm font-semibold mt-1"
                  style={{ color: colors[idx % colors.length] }}
                >
                  {r.label ?? "—"}
                </p>
              </div>
              <Button
                as={Link}
                to={`/benchmarks/${encodeURIComponent(r.runId)}`}
                size="sm"
                variant="flat"
              >
                View jobs →
              </Button>
            </CardHeader>
            <Divider />
            <CardBody className="space-y-1 text-sm">
              <Row label="total" value={r.total} />
              <Row label="completed" value={`${r.completed} (${(r.successRate * 100).toFixed(1)}%)`} />
              <Row label="failed" value={r.failed} />
              <Row label="in-flight" value={r.inFlight} />
              <Divider className="my-1" />
              <Row label="p50 latency" value={`${r.p50LatencyMs} ms`} />
              <Row label="p95 latency" value={`${r.p95LatencyMs} ms`} />
              <Divider className="my-1" />
              <Row label="scored" value={`${r.scored} / ${r.total}`} />
              <Row
                label="avg score"
                value={r.avgScore != null ? r.avgScore.toFixed(3) : "—"}
              />
              {r.estimated > 0 && (
                <>
                  <Divider className="my-1" />
                  <Row label="estimated" value={`${r.estimated} / ${r.total}`} />
                  <Row
                    label="MAE (pts)"
                    value={r.meanAbsError != null ? r.meanAbsError.toFixed(2) : "—"}
                  />
                  <Row
                    label="bias (pts)"
                    value={r.bias != null ? formatBias(r.bias) : "—"}
                  />
                </>
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Quality chart */}
      <Card>
        <CardHeader>
          <p className="text-md">Quality</p>
        </CardHeader>
        <Divider />
        <CardBody style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={metricChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="metric" stroke="#9ca3af" />
              <YAxis domain={[0, 1]} stroke="#9ca3af" />
              <Tooltip contentStyle={{ background: "#1f2937", border: "none" }} />
              <Legend />
              {rows.map((r, idx) => (
                <Bar
                  key={r.runId}
                  dataKey={labelKey(r)}
                  fill={colors[idx % colors.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardBody>
      </Card>

      {/* Latency chart */}
      <Card>
        <CardHeader>
          <p className="text-md">Latency</p>
        </CardHeader>
        <Divider />
        <CardBody style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={latencyChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="metric" stroke="#9ca3af" />
              <YAxis stroke="#9ca3af" />
              <Tooltip contentStyle={{ background: "#1f2937", border: "none" }} />
              <Legend />
              {rows.map((r, idx) => (
                <Bar
                  key={r.runId}
                  dataKey={labelKey(r)}
                  fill={colors[idx % colors.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardBody>
      </Card>

      {/* Estimation chart — only when there's something to plot. */}
      {anyEstimated && (
        <Card>
          <CardHeader className="flex flex-col gap-1 items-start">
            <p className="text-md">Estimation accuracy</p>
            <p className="text-xs text-default-500">
              <Code size="sm">MAE</Code> = mean(|actual − estimated|) — lower is
              better. <Code size="sm">bias</Code> = mean(actual − estimated) —
              positive means consistently under-estimating; negative means
              over-estimating; near zero means estimates are well-calibrated.
            </p>
          </CardHeader>
          <Divider />
          <CardBody style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={estimationChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="metric" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip contentStyle={{ background: "#1f2937", border: "none" }} />
                <Legend />
                {rows.map((r, idx) => (
                  <Bar
                    key={r.runId}
                    dataKey={labelKey(r)}
                    fill={colors[idx % colors.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
      )}

      {/* Detail table */}
      <Card>
        <CardHeader>
          <p className="text-md">All metrics</p>
        </CardHeader>
        <Divider />
        <CardBody>
          <Table aria-label="Benchmark runs">
            <TableHeader>
              <TableColumn>runId</TableColumn>
              <TableColumn>label</TableColumn>
              <TableColumn>total</TableColumn>
              <TableColumn>completed</TableColumn>
              <TableColumn>failed</TableColumn>
              <TableColumn>in-flight</TableColumn>
              <TableColumn>p50ms</TableColumn>
              <TableColumn>p95ms</TableColumn>
              <TableColumn>success</TableColumn>
              <TableColumn>scored</TableColumn>
              <TableColumn>avgScore</TableColumn>
              <TableColumn>est</TableColumn>
              <TableColumn>MAE</TableColumn>
              <TableColumn>bias</TableColumn>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.runId}>
                  <TableCell>
                    <Code size="sm">{r.runId.slice(0, 12)}…</Code>
                  </TableCell>
                  <TableCell>{r.label ?? "—"}</TableCell>
                  <TableCell>{r.total}</TableCell>
                  <TableCell>{r.completed}</TableCell>
                  <TableCell>{r.failed}</TableCell>
                  <TableCell>{r.inFlight}</TableCell>
                  <TableCell>{r.p50LatencyMs}</TableCell>
                  <TableCell>{r.p95LatencyMs}</TableCell>
                  <TableCell>{(r.successRate * 100).toFixed(1)}%</TableCell>
                  <TableCell>{r.scored}</TableCell>
                  <TableCell>{r.avgScore != null ? r.avgScore.toFixed(3) : "—"}</TableCell>
                  <TableCell>{r.estimated}</TableCell>
                  <TableCell>{r.meanAbsError != null ? r.meanAbsError.toFixed(2) : "—"}</TableCell>
                  <TableCell>{r.bias != null ? formatBias(r.bias) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Format signed bias with an explicit sign so the direction is obvious
 * at a glance. Negative values already render with "-"; positive get a
 * leading "+".
 */
function formatBias(b: number): string {
  const r = b.toFixed(2);
  return b > 0 ? `+${r}` : r;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-default-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * Build per-row record where each key is a run's display label and
 * the value is the metric. Recharts uses the dataKey to pick the
 * column, so we project { metric, "qwen-0.6b": 0.83, "qwen-4b": 0.91 }.
 */
function rowsByLabel(
  rows: BenchmarkRunSummary[],
  pick: (r: BenchmarkRunSummary) => number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[labelKey(r)] = pick(r);
  }
  return out;
}

function labelKey(r: BenchmarkRunSummary): string {
  return r.label && r.label.trim() ? r.label : r.runId.slice(0, 8);
}
