// Doc-Chase Agent ("Ava") — inbound reply endpoint.
//
// Wired to a GHL workflow on "Customer Replied" (SMS) that POSTs
// { contactId, body, secret } here. Follows the same flexible-payload +
// shared-secret convention as /api/webhooks/ghl-tags (secret in the body,
// or an x-webhook-secret header).
//
// Flow: resolve contact -> log inbound -> honor STOP -> run Ava ->
// send + log outbound -> handle [ESCALATE]/[SNOOZE] -> completion check.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ghlSendSMS } from "@/lib/ghl-api";
import { runAva } from "@/lib/doc-chase/ava";
import { logDocChaseMessage, escalateToHuman, completeDocChase } from "@/lib/doc-chase/handoff";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STOP_WORDS = new Set(["stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out"]);
const COMPLETION_DONE_STATUSES = new Set([
    "documents_received", "under_review", "lender_matched", "funded", "declined",
]);

export async function POST(request: Request) {
    try {
        // 1. Parse payload (GHL can send JSON or form-urlencoded).
        const contentType = request.headers.get("content-type") || "";
        let payload: any;
        if (contentType.includes("application/json")) {
            payload = await request.json();
        } else {
            const text = await request.text();
            try {
                payload = JSON.parse(text);
            } catch {
                payload = Object.fromEntries(new URLSearchParams(text).entries());
            }
        }

        // 2. Verify shared secret.
        const webhookSecret = process.env.GHL_WEBHOOK_SECRET;
        if (!webhookSecret) {
            console.error("[docchase/reply] GHL_WEBHOOK_SECRET is not defined");
            return NextResponse.json({ error: "Configuration Error" }, { status: 500 });
        }
        const providedSecret = payload?.secret ?? request.headers.get("x-webhook-secret");
        if (providedSecret !== webhookSecret) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // 3. Extract contact + message body (field names vary by GHL workflow setup).
        let contactId: string | undefined =
            payload?.contactId ?? payload?.contact_id ?? payload?.contact?.id;
        if (typeof contactId === "string") {
            contactId = contactId.trim().replace(/^["']|["']$/g, "");
        }
        const inboundBody: string = String(
            payload?.body ?? payload?.message ?? payload?.text ?? ""
        ).trim();

        if (!contactId || !inboundBody) {
            return NextResponse.json({ error: "contactId and body required" }, { status: 400 });
        }

        // 4. Resolve to the client record.
        const supabase = createAdminClient();
        const { data: vault } = await supabase
            .from("client_data_vault")
            .select("id, ghl_contact_id, sms_consent, ava_handed_off")
            .eq("ghl_contact_id", contactId)
            .maybeSingle();
        if (!vault) {
            console.warn(`[docchase/reply] no client for GHL contact ${contactId} — ignoring`);
            return NextResponse.json({ ok: true, ignored: "unknown_contact" });
        }

        // 5. Log the inbound (this also resets Ava's unanswered-nudge counter,
        //    which is derived from the transcript).
        await logDocChaseMessage(vault.id, "inbound", inboundBody);

        // 5a. Opted out or already handed to a human -> Ava stays silent.
        //     (The transcript still captures the inbound for the advisor.)
        if (vault.sms_consent === false) {
            return NextResponse.json({ ok: true, ignored: "no_sms_consent" });
        }
        if (vault.ava_handed_off === true) {
            return NextResponse.json({ ok: true, ignored: "handed_off_to_human" });
        }

        // 6. Honor STOP — flip consent off, no reply (carrier/GHL confirms opt-out).
        if (STOP_WORDS.has(inboundBody.toLowerCase())) {
            await supabase
                .from("client_data_vault")
                .update({ sms_consent: false })
                .eq("id", vault.id);
            return NextResponse.json({ ok: true, action: "opted_out" });
        }

        // 7. Re-engagement clears any short snooze.
        await supabase
            .from("client_data_vault")
            .update({ reminders_paused_until: null })
            .eq("id", vault.id);

        // 8. Run Ava on the reply.
        const ava = await runAva(vault.id, "reply");
        if (!ava) {
            return NextResponse.json({ ok: true, ignored: "no_doc_state" });
        }

        if (ava.text) {
            await ghlSendSMS(contactId, ava.text);
            await logDocChaseMessage(vault.id, "outbound", ava.text);
        }

        if (ava.snoozeHours) {
            await supabase
                .from("client_data_vault")
                .update({ reminders_paused_until: new Date(Date.now() + ava.snoozeHours * 36e5).toISOString() })
                .eq("id", vault.id);
        }
        if (ava.escalate || ava.usedFallback) {
            // A fallback reply means the model errored mid-conversation — make
            // sure a human picks it up rather than leaving the client hanging.
            await escalateToHuman(
                vault.id,
                ava.escalate ? "Ava flagged the conversation for a human" : "Ava fallback reply (model error) — review the thread"
            );
        }

        // 9. Completion check — if nothing is outstanding anymore, advance.
        if (ava.state.outstandingDocs.length === 0) {
            const { data: statusRows } = await supabase
                .from("loan_status_history")
                .select("status")
                .eq("client_vault_id", vault.id)
                .order("created_at", { ascending: false })
                .limit(1);
            const latest = statusRows?.[0]?.status;
            if (!latest || !COMPLETION_DONE_STATUSES.has(latest)) {
                await completeDocChase(vault.id);
            }
        }

        return NextResponse.json({
            ok: true,
            action: ava.escalate ? "replied_and_escalated" : "replied",
        });
    } catch (err: any) {
        console.error("[docchase/reply] failed:", err);
        return NextResponse.json({ error: err?.message ?? "unknown" }, { status: 500 });
    }
}
