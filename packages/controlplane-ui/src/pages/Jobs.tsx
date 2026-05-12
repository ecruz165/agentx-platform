import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
  Button,
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
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button as={Link} to="/jobs/new" color="primary" size="sm">
          New job
        </Button>
      </div>
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
    </div>
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
