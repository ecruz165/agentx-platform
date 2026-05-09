import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Code,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  Tab,
  Tabs,
  useDisclosure,
} from "@heroui/react";
import { ProposalStatus, RemoteStatus, SkillProposal, skillProposals } from "../lib/api";

/**
 * Skill-proposal admin queue. Shows proposals (defaults to status=
 * proposed); each card surfaces the proposed skill's name, category,
 * tags, rationale, source-job link, and Approve / Reject actions.
 *
 * Approve: POSTs to controlplane → service seeds a draft into
 * catalog_items + transitions the proposal to status=approved.
 * Reject: prompts for a reason via modal → POSTs with the reason.
 */
export default function ProposalsPage() {
  const [status, setStatus] = useState<ProposalStatus>("proposed");

  const { data, isPending, error } = useQuery({
    queryKey: ["skill-proposals", status],
    queryFn: () => skillProposals.list(status),
    refetchInterval: 5_000,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-1 items-start">
          <p className="text-md font-semibold">Skill proposals</p>
          <p className="text-sm text-default-500">
            Surfaced from job reflections that flagged{" "}
            <Code size="sm">{`{kind:"missing-skill"}`}</Code> surprises.
            Approve to seed a draft into the catalog.
          </p>
        </CardHeader>
        <Divider />
        <CardBody>
          <Tabs
            selectedKey={status}
            onSelectionChange={(k) => setStatus(k as ProposalStatus)}
            aria-label="proposal status"
          >
            <Tab key="proposed" title="Proposed" />
            <Tab key="approved" title="Approved" />
            <Tab key="rejected" title="Rejected" />
          </Tabs>
        </CardBody>
      </Card>

      {isPending && <Spinner label="Loading proposals…" />}
      {error && <Code color="danger">{String(error)}</Code>}
      {data && data.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-default-500">No {status} proposals.</p>
          </CardBody>
        </Card>
      )}
      {data && data.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {data.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: SkillProposal }) {
  const qc = useQueryClient();
  const rejectModal = useDisclosure();
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await skillProposals.approve(proposal.id);
      await qc.invalidateQueries({ queryKey: ["skill-proposals"] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejectReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await skillProposals.reject(proposal.id, rejectReason);
      rejectModal.onClose();
      setRejectReason("");
      await qc.invalidateQueries({ queryKey: ["skill-proposals"] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resubmit() {
    setBusy(true);
    setError(null);
    try {
      await skillProposals.resubmit(proposal.id);
      await qc.invalidateQueries({ queryKey: ["skill-proposals"] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Show resubmit only on approved proposals that have either never
  // been pushed (remoteStatus == null — likely approved before
  // skillzkit was wired) or failed transport (remoteStatus === 'failed').
  // In-flight states (pending/reviewing) and terminal-accepted states
  // (accepted/promoted/rejected by skillzkit) shouldn't show resubmit:
  // they're either polling or settled.
  const canResubmit =
    proposal.status === "approved" &&
    (proposal.remoteStatus == null || proposal.remoteStatus === "failed");

  return (
    <Card>
      <CardHeader className="flex justify-between items-start gap-2">
        <div className="flex flex-col gap-1">
          <Code size="sm" className="font-mono">
            {proposal.name}
          </Code>
          <div className="flex flex-wrap gap-1">
            {proposal.category && (
              <Chip size="sm" variant="flat">
                {proposal.category}
              </Chip>
            )}
            {proposal.tags.map((t) => (
              <Chip key={t} size="sm" variant="flat" color="default">
                {t}
              </Chip>
            ))}
            <StatusChip status={proposal.status} />
            {proposal.status === "approved" && (
              <SkillzkitChip
                remoteStatus={proposal.remoteStatus}
                remoteUrl={proposal.remoteUrl}
              />
            )}
          </div>
        </div>
      </CardHeader>
      <Divider />
      <CardBody className="space-y-2 text-sm">
        {proposal.description && (
          <div>
            <span className="text-default-500 text-xs">description</span>
            <p>{proposal.description}</p>
          </div>
        )}
        {proposal.rationale && (
          <div>
            <span className="text-default-500 text-xs">rationale</span>
            <p>{proposal.rationale}</p>
          </div>
        )}
        {proposal.sourceJobId && (
          <div>
            <span className="text-default-500 text-xs">source job</span>
            <Code size="sm" className="block">
              {proposal.sourceJobId}
            </Code>
          </div>
        )}
        {proposal.status === "approved" && proposal.catalogItemId && (
          <div>
            <span className="text-default-500 text-xs">catalog item</span>
            <Code size="sm" className="block">
              {proposal.catalogItemId}
            </Code>
          </div>
        )}
        {proposal.status === "rejected" && proposal.rejectionReason && (
          <div>
            <span className="text-default-500 text-xs">rejection reason</span>
            <p className="text-danger-500">{proposal.rejectionReason}</p>
          </div>
        )}
        {proposal.status === "approved" && proposal.remoteError && (
          <div>
            <span className="text-default-500 text-xs">skillzkit error</span>
            <p className="text-danger-500 break-words">{proposal.remoteError}</p>
          </div>
        )}
        {error && <Code color="danger">{error}</Code>}

        {proposal.status === "proposed" && (
          <>
            <Divider />
            <div className="flex gap-2">
              <Button color="success" onPress={approve} isLoading={busy}>
                Approve
              </Button>
              <Button color="danger" variant="flat" onPress={rejectModal.onOpen}>
                Reject
              </Button>
            </div>
          </>
        )}

        {canResubmit && (
          <>
            <Divider />
            <div className="flex gap-2 items-center">
              <Button color="primary" variant="flat" onPress={resubmit} isLoading={busy}>
                Resubmit to skillzkit
              </Button>
              <span className="text-xs text-default-500">
                {proposal.remoteStatus === "failed"
                  ? "Last submit failed — retry"
                  : "Approved before skillzkit was wired"}
              </span>
            </div>
          </>
        )}
      </CardBody>

      <Modal isOpen={rejectModal.isOpen} onClose={rejectModal.onClose}>
        <ModalContent>
          <ModalHeader>Reject {proposal.name}</ModalHeader>
          <ModalBody>
            <Input
              label="Reason"
              placeholder="Why is this proposal being rejected?"
              value={rejectReason}
              onValueChange={setRejectReason}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={rejectModal.onClose}>
              Cancel
            </Button>
            <Button color="danger" onPress={reject} isLoading={busy} isDisabled={!rejectReason.trim()}>
              Reject
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
}

function StatusChip({ status }: { status: ProposalStatus }) {
  const tone =
    status === "approved"
      ? "success"
      : status === "rejected"
        ? "danger"
        : "primary";
  return (
    <Chip size="sm" color={tone} variant="flat">
      {status}
    </Chip>
  );
}

/**
 * Skillzkit upstream-submission status. Distinct from the proposal's
 * own status (the local approve/reject flow). Only meaningful on
 * approved proposals — the parent gates rendering accordingly.
 *
 *   - null            → never submitted (e.g., skillzkit not configured
 *                       at approve time). Operator sees the resubmit
 *                       button below.
 *   - pending         → submitted, awaiting skillzkit's review.
 *   - reviewing       → skillzkit reviewer engaged.
 *   - accepted/promoted → terminal success; local draft was dropped.
 *   - rejected        → skillzkit declined; local draft kept.
 *   - failed          → transport / 5xx error on submit. Resubmit
 *                       button below offers retry.
 */
function SkillzkitChip({
  remoteStatus,
  remoteUrl,
}: {
  remoteStatus?: RemoteStatus;
  remoteUrl?: string;
}) {
  if (remoteStatus == null) {
    return (
      <Chip size="sm" color="warning" variant="flat">
        skillzkit: not sent
      </Chip>
    );
  }
  const tone: "primary" | "success" | "danger" | "warning" =
    remoteStatus === "accepted" || remoteStatus === "promoted"
      ? "success"
      : remoteStatus === "rejected" || remoteStatus === "failed"
        ? "danger"
        : remoteStatus === "reviewing"
          ? "primary"
          : "warning"; // 'pending'
  const label = `skillzkit: ${remoteStatus}`;

  // Wrap the chip in a link only when we have a destination. The
  // remoteUrl is the skillzkit /api/v1/contributions/{id} endpoint —
  // useful for ops debugging even though it's an API path, not a UI
  // route. Future: if skillzkit ships a UI per-contribution page,
  // wire that URL on its side.
  const chip = (
    <Chip size="sm" color={tone} variant="flat">
      {label}
    </Chip>
  );
  if (remoteUrl) {
    return (
      <a href={remoteUrl} target="_blank" rel="noreferrer" title={remoteUrl}>
        {chip}
      </a>
    );
  }
  return chip;
}
