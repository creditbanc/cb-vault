// Doc-Chase Agent ("Ava") — hourly cron.
//
// Runs ALONGSIDE the existing email reminder cron (send-document-reminders) and
// deliberately does NOT touch its cadence columns (last_reminder_sent_at /
// reminder_count). Ava's cadence is derived from her own transcript
// (doc_chase_messages), so the two systems can't trip over each other.
//
// Per run, for every eligible client:
//   first touch  -> outbound #1 (full intro + magic link)
//   follow-ups   -> 24h after outbound #1, 48h after outbound #2 (no reply)
//   cap          -> 3 unanswered nudges => escalate to the advisor, stop
//   completion   -> nothing outstanding => completion SMS + status advance
//
// Query params: ?dry=1 (no sends/writes), ?clientId=<uuid> (single client),
//               ?force=1 (ignore quiet hours — for testing).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ghlSendSMS } from "@/lib/ghl-api";
import { runAva } from "@/lib/doc-chase/ava";
import { getDocState } from "@/lib/doc-chase/doc-state";
import { logDocChaseMessage, escalateToHuman, completeDocChase } from "@/lib/doc-chase/handoff";

export const maxDuration = 300;

// --- Config (decisions from Matt, 2026-06-03) -------------------------------
const QUIET_HOURS = { startHour: 9, endHour: 21 }; // 9am–9pm ET
const TIMEZONE = "America/New_York";
const NUDGE_CAP = 3; // unanswered outbounds before human handoff
// Gap (hours) required since Ava's last outbound, indexed by how many
// unanswered outbounds precede this one: after reply -> 24h, after #1 -> 24h,
// after #2 -> 48h.
const FOLLOW_UP_GAP_HOURS = [24, 24, 48];
const MAX_SENDS_PER_RUN = 50;

const STOP_PIPELINE_STATUSES = new Set(["funded", "declined"]);
const COMPLETION_DONE_STATUSES = new Set([
    "documents_received", "under_review", "lender_matched", "funded", "declined",
]);
const STOP_SUBMISSION_STATUSES = new Set(["locked"]);

// Pilot scope, e.g. "MCA" or "MCA,Term Loan". Empty/unset = all loan types.
function pilotLoanTypes(): string[] {
    return (process.env.DOC_CHASE_PILOT_LOAN_TYPES || "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

interface RunResult {
    clientVaultId: string;
    action: "sent" | "escalated" | "completed" | "skipped" | "would_send" | "error";
    turnType?: string;
    skipReason?: string;
    error?: string;
}

function isAuthorized(req: Request): boolean {
    if (process.env.NODE_ENV === "development") return true;
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        console.error("[cron/doc-chase] CRON_SECRET is not set in env");
        return false;
    }
    return (req.headers.get("authorization") || "") === `Bearer ${expected}`;
}

function hourInET(d: Date): number {
    const h = parseInt(
        new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "numeric", hour12: false }).format(d),
        10
    );
    return h % 24;
}

function hoursBetween(a: Date, b: Date): number {
    return Math.abs(a.getTime() - b.getTime()) / 36e5;
}

export async function GET(req: Request) {
    if (!isAuthorized(req)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const dryRun = url.searchParams.get("dry") === "1";
    // Dry runs never call the model — only block live runs on a missing key.
    if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }
    const onlyClientId = url.searchParams.get("clientId");
    const force = url.searchParams.get("force") === "1";

    const now = new Date();
    const etHour = hourInET(now);
    if (!force && (etHour < QUIET_HOURS.startHour || etHour >= QUIET_HOURS.endHour)) {
        return NextResponse.json({ ok: true, skipped: "quiet_hours", etHour });
    }

    const supabase = createAdminClient();

    // 1. Candidate clients.
    let query = supabase
        .from("client_data_vault")
        .select("id, user_id, proposed_loan_type, reminders_paused_until, ghl_contact_id, sms_consent, ava_handed_off")
        .eq("sms_consent", true)
        .eq("ava_handed_off", false)
        .not("ghl_contact_id", "is", null);
    if (onlyClientId) query = query.eq("id", onlyClientId);

    const { data: clients, error: clientsError } = await query;
    if (clientsError) {
        return NextResponse.json({ error: clientsError.message }, { status: 500 });
    }
    if (!clients?.length) {
        return NextResponse.json({ ok: true, scanned: 0, results: [] });
    }

    const vaultIds = clients.map(c => c.id);
    const userIds = clients.map(c => c.user_id);

    // 2. Latest pipeline status per client.
    const { data: statusRows } = await supabase
        .from("loan_status_history")
        .select("client_vault_id, status, created_at")
        .in("client_vault_id", vaultIds)
        .order("created_at", { ascending: false });
    const pipelineMap = new Map<string, string>();
    (statusRows || []).forEach(r => {
        if (!pipelineMap.has(r.client_vault_id)) pipelineMap.set(r.client_vault_id, r.status);
    });

    // 3. Submission status per user.
    const { data: subRows } = await supabase
        .from("submissions")
        .select("user_id, status")
        .in("user_id", userIds);
    const submissionMap = new Map<string, string>((subRows || []).map(s => [s.user_id, s.status]));

    // 4. Ava's own cadence, derived from her transcript.
    const { data: msgRows } = await supabase
        .from("doc_chase_messages")
        .select("client_vault_id, direction, created_at")
        .in("client_vault_id", vaultIds)
        .order("created_at", { ascending: true });

    interface Cadence { totalOutbound: number; lastOutbound: Date | null; lastInbound: Date | null; unanswered: number }
    const cadenceMap = new Map<string, Cadence>();
    (msgRows || []).forEach(m => {
        const c = cadenceMap.get(m.client_vault_id) ?? { totalOutbound: 0, lastOutbound: null, lastInbound: null, unanswered: 0 };
        const ts = new Date(m.created_at);
        if (m.direction === "outbound") {
            c.totalOutbound += 1;
            c.lastOutbound = ts;
            c.unanswered += 1;
        } else {
            c.lastInbound = ts;
            c.unanswered = 0; // a reply resets the nudge counter
        }
        cadenceMap.set(m.client_vault_id, c);
    });

    const pilot = pilotLoanTypes();
    const results: RunResult[] = [];
    let sends = 0;

    // 5. Per-client decision loop.
    for (const client of clients) {
        const result: RunResult = { clientVaultId: client.id, action: "skipped" };
        try {
            if (sends >= MAX_SENDS_PER_RUN) {
                result.skipReason = "run_send_cap";
                results.push(result);
                continue;
            }

            // proposed_loan_type can be multi-value ("SBA Loan, Project Financing,
            // Real Estate Loan") — in pilot if ANY of the client's types matches.
            const clientLoanTypes = (client.proposed_loan_type || "")
                .split(",")
                .map((s: string) => s.trim().toLowerCase())
                .filter(Boolean);
            if (pilot.length && !clientLoanTypes.some((t: string) => pilot.includes(t))) {
                result.skipReason = "outside_pilot";
                results.push(result);
                continue;
            }
            if (client.reminders_paused_until && new Date(client.reminders_paused_until) > now) {
                result.skipReason = "paused";
                results.push(result);
                continue;
            }
            const pipeline = pipelineMap.get(client.id);
            if (pipeline && STOP_PIPELINE_STATUSES.has(pipeline)) {
                result.skipReason = `pipeline_${pipeline}`;
                results.push(result);
                continue;
            }
            const submission = submissionMap.get(client.user_id);
            if (submission && STOP_SUBMISSION_STATUSES.has(submission)) {
                result.skipReason = `submission_${submission}`;
                results.push(result);
                continue;
            }

            const cadence = cadenceMap.get(client.id) ?? { totalOutbound: 0, lastOutbound: null, lastInbound: null, unanswered: 0 };
            const state = await getDocState(client.id);
            if (!state) {
                result.skipReason = "no_vault_record";
                results.push(result);
                continue;
            }

            // --- Completion path ------------------------------------------
            if (state.outstandingDocs.length === 0) {
                const alreadyAdvanced = pipeline ? COMPLETION_DONE_STATUSES.has(pipeline) : false;
                if (cadence.totalOutbound === 0 || alreadyAdvanced) {
                    result.skipReason = "no_outstanding_docs";
                    results.push(result);
                    continue;
                }
                if (dryRun) {
                    result.action = "would_send";
                    result.turnType = "completion";
                    results.push(result);
                    continue;
                }
                const advisor = state.advisorName ?? "your Credit Banc advisor";
                const completionText = `${state.clientFirstName}, that's everything — all your documents are in! 🎉 ${advisor} will take it from here and be in touch shortly.`;
                await ghlSendSMS(state.ghlContactId!, completionText);
                await logDocChaseMessage(client.id, "outbound", completionText);
                await completeDocChase(client.id);
                sends++;
                result.action = "completed";
                results.push(result);
                continue;
            }

            // --- First touch / follow-up timing -----------------------------
            // The cap check sits BEHIND the same gap as a send would: we
            // escalate *instead of* sending the 4th nudge, not an hour after
            // the 3rd one (give the client the full window to reply).
            const turnType = cadence.totalOutbound === 0 ? "first_touch" : "follow_up";
            if (turnType === "follow_up" && cadence.lastOutbound) {
                const gapIdx = Math.min(cadence.unanswered, FOLLOW_UP_GAP_HOURS.length - 1);
                const needed = FOLLOW_UP_GAP_HOURS[gapIdx];
                const since = hoursBetween(now, cadence.lastOutbound);
                if (since < needed) {
                    result.skipReason = `too_soon_${Math.round(since)}h_of_${needed}h`;
                    results.push(result);
                    continue;
                }
            }

            // --- Cap reached -> human handoff instead of another nudge ------
            if (cadence.unanswered >= NUDGE_CAP) {
                if (dryRun) {
                    result.action = "would_send";
                    result.turnType = "escalation";
                    results.push(result);
                    continue;
                }
                await escalateToHuman(client.id, `No reply after ${cadence.unanswered} automated nudges`);
                result.action = "escalated";
                results.push(result);
                continue;
            }

            if (dryRun) {
                result.action = "would_send";
                result.turnType = turnType;
                results.push(result);
                continue;
            }

            // --- Compose + send ---------------------------------------------
            const ava = await runAva(client.id, turnType, cadence.unanswered + 1);
            if (!ava || !ava.text) {
                result.action = "error";
                result.error = "ava_no_output";
                results.push(result);
                continue;
            }

            await ghlSendSMS(state.ghlContactId!, ava.text);
            await logDocChaseMessage(client.id, "outbound", ava.text);
            sends++;

            if (ava.snoozeHours) {
                await supabase
                    .from("client_data_vault")
                    .update({ reminders_paused_until: new Date(now.getTime() + ava.snoozeHours * 36e5).toISOString() })
                    .eq("id", client.id);
            }
            if (ava.escalate) {
                await escalateToHuman(client.id, "Ava flagged the conversation for a human");
                result.action = "escalated";
            } else {
                result.action = "sent";
            }
            result.turnType = turnType;
            results.push(result);
        } catch (err: any) {
            console.error(`[cron/doc-chase] client ${client.id} failed:`, err);
            result.action = "error";
            result.error = err?.message ?? "unknown";
            results.push(result);
        }
    }

    const summary = {
        ok: true,
        dryRun,
        ranAt: now.toISOString(),
        etHour,
        scanned: clients.length,
        sent: results.filter(r => r.action === "sent").length,
        completed: results.filter(r => r.action === "completed").length,
        escalated: results.filter(r => r.action === "escalated").length,
        wouldSend: results.filter(r => r.action === "would_send").length,
        skipped: results.filter(r => r.action === "skipped").length,
        errored: results.filter(r => r.action === "error").length,
        results,
    };
    return NextResponse.json(summary);
}
