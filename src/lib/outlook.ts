/** Future Graph adapter must use tenant-admin approved, least-privilege permissions.
 * This MVP deliberately has no live-send implementation. */
export interface MailProvider {
  ingest(cursor?: string): Promise<{ messageId: string; threadId: string; body: string }[]>;
  deliver(draft: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
  }): Promise<{ mode: 'simulated'; receipt: string }>;
}
export class SimulatedOutlook implements MailProvider {
  async ingest() {
    return [];
  }
  async deliver() {
    return { mode: 'simulated' as const, receipt: `SIM-${crypto.randomUUID()}` };
  }
}
