import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Select,
  SelectItem,
  Spinner,
  Textarea,
} from "@heroui/react";
import { catalog, jobs, type SubmitJobRequest } from "../lib/api";

/**
 * Gate 1b.2 — direct job submission surface for users who already know
 * which flow + product they want. The Intake page remains the primary
 * multi-turn intent-capture flow; this page is the escape hatch.
 *
 * Flow + product dropdowns are populated from {@code /api/catalog/*}.
 * The free-text "change" is wrapped as {@code { change: <text> }} and
 * sent to {@code POST /api/jobs}; on success we redirect to /jobs.
 */
export default function SubmitJobPage() {
  const navigate = useNavigate();

  const flowsQ = useQuery({ queryKey: ["catalog", "flows"], queryFn: catalog.flows });
  const productsQ = useQuery({ queryKey: ["catalog", "products"], queryFn: catalog.products });

  const [flowId, setFlowId] = useState("");
  const [productId, setProductId] = useState("");
  const [change, setChange] = useState("");

  const submitM = useMutation({
    mutationFn: (body: SubmitJobRequest) => jobs.submit(body),
    onSuccess: () => navigate("/jobs"),
  });

  const disabled =
    submitM.isPending ||
    flowId.trim() === "" ||
    productId.trim() === "" ||
    change.trim() === "";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitM.mutate({
      flowId,
      productId,
      input: { change },
    });
  }

  // Only "work" flows are valid here. job-definition flows belong to the
  // Intake surface; post-job flows aren't user-submittable.
  const workFlows = (flowsQ.data ?? []).filter((f) => f.kind === "work");

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-1">
        <span className="text-lg font-semibold">Submit job</span>
        <span className="text-sm text-default-500">
          Direct submission to <Code size="sm">POST /api/jobs</Code>. For
          guided intent capture, use the Intake page.
        </span>
      </CardHeader>
      <Divider />
      <CardBody>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 max-w-2xl">
          <Select
            label="Flow"
            placeholder={flowsQ.isPending ? "Loading flows…" : "Pick a work flow"}
            isDisabled={flowsQ.isPending || !!flowsQ.error}
            selectedKeys={flowId ? [flowId] : []}
            onChange={(e) => setFlowId(e.target.value)}
          >
            {workFlows.map((f) => (
              <SelectItem key={f.id} description={f.description}>
                {f.id}
              </SelectItem>
            ))}
          </Select>

          <Select
            label="Product"
            placeholder={productsQ.isPending ? "Loading products…" : "Pick a product"}
            isDisabled={productsQ.isPending || !!productsQ.error}
            selectedKeys={productId ? [productId] : []}
            onChange={(e) => setProductId(e.target.value)}
          >
            {(productsQ.data ?? []).map((p) => (
              <SelectItem key={p.id} description={p.displayName ?? undefined}>
                {p.id}
              </SelectItem>
            ))}
          </Select>

          <Textarea
            label="Change"
            placeholder='e.g. "Bump axios to ^1.7.4 and re-run the lockfile."'
            minRows={4}
            value={change}
            onChange={(e) => setChange(e.target.value)}
          />

          {submitM.error ? (
            <Code color="danger" size="sm">
              {String(submitM.error)}
            </Code>
          ) : null}

          <div className="flex items-center gap-3">
            <Button color="primary" type="submit" isDisabled={disabled}>
              {submitM.isPending ? <Spinner size="sm" color="white" /> : "Submit"}
            </Button>
            <Button variant="light" onPress={() => navigate("/jobs")}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
