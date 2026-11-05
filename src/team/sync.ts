import { TEAM_CAPABILITY_RENEW_MS } from './contracts.js';
import type { TeamConnection } from './session.js';
import type { PeerCapabilities } from './coordination.js';

/** Owns capability reporting; a stale response cannot publish over a newer membership. */
export class TeamSync {
  private reportRun: Promise<void> | null = null;
  private reportSignature = '';
  private reportedAt = 0;

  constructor(
    private readonly connect: () => TeamConnection,
    private readonly now = Date.now,
  ) {}

  publishCapabilities(report: Omit<PeerCapabilities, 'observedAt'>): Promise<void> {
    if (this.reportRun) return this.reportRun;
    this.reportRun = this.publish(report).finally(() => {
      this.reportRun = null;
    });
    return this.reportRun;
  }

  private async publish(report: Omit<PeerCapabilities, 'observedAt'>): Promise<void> {
    const connection = this.connect();
    try {
      const signature = JSON.stringify({ membership: connection.key, report });
      // Renew the observation before the roster's 45s freshness window expires.
      if (signature === this.reportSignature && this.now() - this.reportedAt < TEAM_CAPABILITY_RENEW_MS) return;
      await connection.channel.reportCapabilities(report);
      if (!connection.isCurrent()) return;
      this.reportSignature = signature;
      this.reportedAt = this.now();
    } finally {
      connection.close();
    }
  }
}
