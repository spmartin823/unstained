import { appendJsonl } from "./atomic-fs.js";

export type AuditEventType =
    | "daemon_start"
    | "daemon_stop"
    | "round_start"
    | "round_end"
    | "worker_spawned"
    | "worker_exit"
    | "worker_heartbeat"
    | "scoreme_received"
    | "scoring_start"
    | "scoring_complete"
    | "score_dq"
    | "selection"
    | "merge"
    | "pr_opened"
    | "cleanup"
    | "error";

export interface AuditEvent {
    readonly t: string;
    readonly ev: AuditEventType;
    readonly [key: string]: unknown;
}

export class Auditor {
    constructor(private readonly auditPath: string) {}

    async log(ev: AuditEventType, payload: Record<string, unknown> = {}): Promise<void> {
        const event: AuditEvent = {
            t: new Date().toISOString(),
            ev,
            ...payload
        };
        await appendJsonl(this.auditPath, event);
    }
}
