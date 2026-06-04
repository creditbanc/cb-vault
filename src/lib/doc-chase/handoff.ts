// Doc-Chase Agent ("Ava") — escalation + completion handoffs.
//
// Escalation: set ava_handed_off (cron skips the client), notify the advisor
// in-app and in the deal's Slack channel.
// Completion: advance pipeline status to documents_received, mark the
// submission submitted, notify advisor + Slack.
// Notifications reuse the existing in_app_notifications / funding_deals
// plumbing — nothing new is invented here.

import { createAdminClient } from "@/lib/supabase/admin";
import { slackPostMessage } from "@/lib/slack-api";

interface VaultMeta {
    id: string;
    user_id: string;
    client_name: string | null;
    company_name: string | null;
    advisor_id: string | null;
}

export async function logDocChaseMessage(
    clientVaultId: string,
    direction: "inbound" | "outbound",
    body: string
): Promise<void> {
    const supabase = createAdminClient();
    const { error } = await supabase
        .from("doc_chase_messages")
        .insert({ client_vault_id: clientVaultId, direction, body });
    if (error) console.error(`[doc-chase] failed to log ${direction} message for ${clientVaultId}:`, error.message);
}

/** Sets ava_handed_off and alerts the advisor. Non-fatal on partial failure. */
export async function escalateToHuman(clientVaultId: string, reason: string): Promise<void> {
    const supabase = createAdminClient();

    await supabase
        .from("client_data_vault")
        .update({ ava_handed_off: true })
        .eq("id", clientVaultId);

    const vault = await getVaultMeta(clientVaultId);
    if (!vault) return;

    const who = `${vault.client_name ?? "Client"}${vault.company_name ? ` (${vault.company_name})` : ""}`;
    await notifyAdvisor(vault, {
        title: "Ava handed off a doc-chase conversation",
        message: `${who} needs a human follow-up. Reason: ${reason}. Ava has stopped texting them.`,
    });
    await postToDealSlack(vault, `:rotating_light: *Ava handoff* — ${who} needs a human follow-up.\nReason: ${reason}\nAva has paused automated texts for this client.`);
}

/**
 * All requested docs are in: advance status, mark submission, notify.
 * Caller is responsible for gating (only run once per documents_requested cycle).
 */
export async function completeDocChase(clientVaultId: string): Promise<void> {
    const supabase = createAdminClient();
    const vault = await getVaultMeta(clientVaultId);
    if (!vault) return;

    await supabase.from("loan_status_history").insert({
        client_vault_id: clientVaultId,
        status: "documents_received",
        changed_by_role: "system",
        note: "Ava (doc-chase): all requested documents received",
    });

    // documents_requested -> submitted; leave draft/locked rows alone.
    await supabase
        .from("submissions")
        .update({ status: "submitted", updated_at: new Date().toISOString() })
        .eq("user_id", vault.user_id)
        .eq("status", "documents_requested");

    const who = `${vault.client_name ?? "Client"}${vault.company_name ? ` (${vault.company_name})` : ""}`;
    await notifyAdvisor(vault, {
        title: "All documents received 🎉",
        message: `${who} has submitted every outstanding document. Ava moved the file to documents_received — ready for review.`,
    });
    await postToDealSlack(vault, `:white_check_mark: *Docs complete* — ${who} has submitted all outstanding documents. File moved to *documents_received*.`);
}

// ---------------------------------------------------------------------------

async function getVaultMeta(clientVaultId: string): Promise<VaultMeta | null> {
    const supabase = createAdminClient();
    const { data } = await supabase
        .from("client_data_vault")
        .select("id, user_id, client_name, company_name, advisor_id")
        .eq("id", clientVaultId)
        .maybeSingle<VaultMeta>();
    return data ?? null;
}

async function notifyAdvisor(vault: VaultMeta, n: { title: string; message: string }): Promise<void> {
    if (!vault.advisor_id) return;
    const supabase = createAdminClient();
    const { data: advisor } = await supabase
        .from("advisors")
        .select("user_id")
        .eq("id", vault.advisor_id)
        .maybeSingle<{ user_id: string | null }>();
    if (!advisor?.user_id) return;

    await supabase.from("in_app_notifications").insert({
        user_id: advisor.user_id,
        client_id: vault.id,
        title: n.title,
        message: n.message,
    });
}

/** Posts to the deal's Slack channel (client -> business_profiles -> funding_deals.slack_channel). */
async function postToDealSlack(vault: VaultMeta, text: string): Promise<void> {
    try {
        const supabase = createAdminClient();
        const { data: businesses } = await supabase
            .from("business_profiles")
            .select("id")
            .eq("client_vault_id", vault.id);
        const bizIds = (businesses ?? []).map(b => b.id);
        if (!bizIds.length) return;

        const { data: deals } = await supabase
            .from("funding_deals")
            .select("slack_channel, created_at")
            .in("business_profile_id", bizIds)
            .not("slack_channel", "is", null)
            .order("created_at", { ascending: false })
            .limit(1);

        const channel = deals?.[0]?.slack_channel;
        if (channel) await slackPostMessage(channel, text);
    } catch (err) {
        console.error(`[doc-chase] Slack post failed for ${vault.id} (non-fatal):`, err);
    }
}
