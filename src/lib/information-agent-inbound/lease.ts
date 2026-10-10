import "server-only";

export class InformationAgentInboundLeaseLostError extends Error {
  constructor() {
    super("Lease de traitement entrant perdu ; traitement abandonné.");
    this.name = "InformationAgentInboundLeaseLostError";
  }
}

export type InboundJobLeaseGuard = () => Promise<boolean>;
export type InboundLeaseFence = {
  leaseId: string;
  messageId: string;
};

export async function ensureInboundJobLease(assertJobLease?: InboundJobLeaseGuard): Promise<void> {
  if (assertJobLease && !(await assertJobLease())) {
    throw new InformationAgentInboundLeaseLostError();
  }
}
