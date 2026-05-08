import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardBody,
  CardHeader,
  Chip,
  Code,
  Divider,
  Spinner,
  Tab,
  Tabs,
} from "@heroui/react";
import { catalog, Flow, Product } from "../lib/api";

export default function CatalogPage() {
  return (
    <Tabs aria-label="Catalog">
      <Tab key="flows" title="Flows">
        <FlowsTab />
      </Tab>
      <Tab key="products" title="Products">
        <ProductsTab />
      </Tab>
    </Tabs>
  );
}

function FlowsTab() {
  const { data, isPending, error } = useQuery({ queryKey: ["flows"], queryFn: catalog.flows });
  if (isPending) return <Spinner label="Loading flows…" />;
  if (error) return <Code color="danger">{String(error)}</Code>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {(data ?? []).map((f: Flow) => (
        <Card key={f.id}>
          <CardHeader className="flex justify-between items-center">
            <Code size="sm">{f.id}</Code>
            <Chip size="sm" variant="flat" color={kindColor(f.kind)}>
              {f.kind}
            </Chip>
          </CardHeader>
          <Divider />
          <CardBody className="gap-2 text-sm">
            <p className="text-default-700">{f.description ?? <em>no description</em>}</p>
            <details className="text-xs">
              <summary className="cursor-pointer text-default-500">nodes ({nodeCount(f.nodes)})</summary>
              <pre className="bg-default-100 p-2 rounded mt-1 overflow-x-auto">
                {JSON.stringify(f.nodes, null, 2)}
              </pre>
            </details>
          </CardBody>
        </Card>
      ))}
      {data && data.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-default-500">
              No flows registered. Register one with{" "}
              <Code size="sm">POST /api/catalog/flows</Code>.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function ProductsTab() {
  const { data, isPending, error } = useQuery({
    queryKey: ["products"],
    queryFn: catalog.products,
  });
  if (isPending) return <Spinner label="Loading products…" />;
  if (error) return <Code color="danger">{String(error)}</Code>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {(data ?? []).map((p: Product) => (
        <Card key={p.id}>
          <CardHeader>
            <div className="flex flex-col">
              <Code size="sm">{p.id}</Code>
              {p.displayName && <span className="text-sm">{p.displayName}</span>}
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function kindColor(kind: Flow["kind"]) {
  return kind === "work"
    ? "primary"
    : kind === "job-definition"
      ? "success"
      : "warning";
}

function nodeCount(nodes: unknown): number {
  return Array.isArray(nodes) ? nodes.length : 0;
}
