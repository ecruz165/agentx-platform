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
} from "@heroui/react";
import { intent, IntentSession } from "../lib/api";

export default function SessionsPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ["sessions"],
    queryFn: intent.list,
    refetchInterval: 3_000,
  });

  if (isPending) return <Spinner label="Loading sessions…" />;
  if (error) return <Code color="danger">{String(error)}</Code>;

  return (
    <Table aria-label="Intent sessions">
      <TableHeader>
        <TableColumn>session</TableColumn>
        <TableColumn>pipeline</TableColumn>
        <TableColumn>status</TableColumn>
        <TableColumn>intake job</TableColumn>
        <TableColumn>work job</TableColumn>
        <TableColumn>created</TableColumn>
      </TableHeader>
      <TableBody emptyContent="No sessions yet — start one in Intake.">
        {(data ?? []).map((s: IntentSession) => (
          <TableRow key={s.id}>
            <TableCell>
              <Link to={`/intake/${s.id}`} className="text-primary text-sm">
                {s.id.slice(0, 8)}…
              </Link>
            </TableCell>
            <TableCell>
              <Code size="sm">{s.intakePipelineId}</Code>
            </TableCell>
            <TableCell>
              <Chip size="sm" variant="flat">
                {s.status}
              </Chip>
            </TableCell>
            <TableCell className="text-xs font-mono">
              {s.intakeJobId?.slice(0, 12) ?? "—"}
            </TableCell>
            <TableCell className="text-xs font-mono">
              {s.workJobId?.slice(0, 12) ?? "—"}
            </TableCell>
            <TableCell className="text-xs text-default-500">
              {new Date(s.createdAt).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
