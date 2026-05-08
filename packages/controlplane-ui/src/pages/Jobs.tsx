import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Spinner,
  Chip,
  Code,
} from "@heroui/react";
import { jobs, Job } from "../lib/api";

export default function JobsPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ["jobs"],
    queryFn: jobs.list,
    refetchInterval: 3_000,
  });

  if (isPending) return <Spinner label="Loading jobs…" />;
  if (error) return <Code color="danger">{String(error)}</Code>;

  return (
    <Table aria-label="Jobs">
      <TableHeader>
        <TableColumn>job id</TableColumn>
        <TableColumn>flow</TableColumn>
        <TableColumn>product</TableColumn>
        <TableColumn>status</TableColumn>
        <TableColumn>started</TableColumn>
        <TableColumn>completed</TableColumn>
      </TableHeader>
      <TableBody emptyContent="No jobs yet.">
        {(data ?? []).map((j: Job) => (
          <TableRow key={j.id}>
            <TableCell>
              <Code size="sm">{j.id.slice(0, 16)}…</Code>
            </TableCell>
            <TableCell>{j.flowId}</TableCell>
            <TableCell>{j.productId}</TableCell>
            <TableCell>{statusChip(j.status)}</TableCell>
            <TableCell className="text-xs text-default-500">
              {j.startedAt ? new Date(j.startedAt).toLocaleTimeString() : "—"}
            </TableCell>
            <TableCell className="text-xs text-default-500">
              {j.completedAt ? new Date(j.completedAt).toLocaleTimeString() : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function statusChip(status: Job["status"]) {
  const color =
    status === "completed" ? "success" :
    status === "failed" || status === "cancelled" ? "danger" :
    status === "running" ? "primary" :
    "default";
  return (
    <Chip size="sm" color={color} variant="flat">
      {status}
    </Chip>
  );
}
