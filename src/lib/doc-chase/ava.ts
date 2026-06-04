// Doc-Chase Agent ("Ava") — conversation engine (Anthropic Messages API).
//
// runAva() is shared by the hourly cron (first touch + follow-ups) and the
// GHL reply webhook. It reads live doc state, builds the prompt, calls the
// model, and parses the [ESCALATE] / [SNOOZE:n] control tokens. On any model
// failure it returns a safe canned fallback instead of a broken message.

import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateDocUploadMagicLink } from "@/lib/magic-link";
import { getDocState, type DocState } from "./doc-state";
import { AVA_PERSONA, buildClientContext, type TurnType } from "./prompt";

const MODEL = process.env.DOC_CHASE_MODEL || "claude-sonnet-4-6";
const HISTORY_LIMIT = 30;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

export interface AvaResult {
    /** Message to send (control tokens stripped). Empty string = send nothing. */
    text: string;
    escalate: boolean;
    snoozeHours: number | null;
    usedFallback: boolean;
    magicLink: string | null;
    state: DocState;
}

export async function runAva(
    clientVaultId: string,
    turnType: TurnType,
    followUpNumber = 0
): Promise<AvaResult | null> {
    const state = await getDocState(clientVaultId);
    if (!state) return null;

    const magicLink = await generateDocUploadMagicLink(state.clientEmail);
    const history = await loadHistory(clientVaultId);
    const messages = buildMessages(history, turnType, followUpNumber);

    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 400,
            system: [
                // Stable persona first — cacheable prefix shared by every client.
                { type: "text", text: AVA_PERSONA, cache_control: { type: "ephemeral" } },
                // Volatile per-client context after the breakpoint.
                { type: "text", text: buildClientContext({ state, magicLink, turnType, followUpNumber }) },
            ],
            messages,
        });

        const raw = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map(b => b.text)
            .join("")
            .trim();

        if (!raw) throw new Error("empty model response");

        const parsed = parseControlTokens(raw);
        return { ...parsed, usedFallback: false, magicLink, state };
    } catch (err) {
        if (err instanceof Anthropic.APIError) {
            console.error(`[doc-chase] Anthropic API error ${err.status} for ${clientVaultId}:`, err.message);
        } else {
            console.error(`[doc-chase] runAva failed for ${clientVaultId}:`, err);
        }
        return {
            text: fallbackMessage(state, magicLink, turnType),
            escalate: false,
            snoozeHours: null,
            usedFallback: true,
            magicLink,
            state,
        };
    }
}

// ---------------------------------------------------------------------------

async function loadHistory(clientVaultId: string) {
    const supabase = createAdminClient();
    const { data } = await supabase
        .from("doc_chase_messages")
        .select("direction, body, created_at")
        .eq("client_vault_id", clientVaultId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT);
    return (data ?? []).reverse(); // oldest first
}

function buildMessages(
    history: { direction: string; body: string }[],
    turnType: TurnType,
    followUpNumber: number
): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = history.map(m => ({
        role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: m.body,
    }));

    if (turnType !== "reply") {
        // Cron-initiated turn: the trigger is a synthetic user message so the
        // model knows why it's speaking now.
        messages.push({
            role: "user",
            content:
                turnType === "first_touch"
                    ? "[automated trigger — not from the client] Send your first outreach SMS to this client now."
                    : `[automated trigger — not from the client] No reply since your last message. Send follow-up #${followUpNumber} now.`,
        });
    }

    // API requires the first message to be role "user".
    if (messages[0]?.role !== "user") {
        messages.unshift({ role: "user", content: "[conversation start]" });
    }
    // Defensive: a reply turn must end on the client's inbound message.
    if (messages[messages.length - 1]?.role !== "user") {
        messages.push({
            role: "user",
            content: "[automated trigger — not from the client] Continue the conversation appropriately.",
        });
    }
    return messages;
}

function parseControlTokens(raw: string): { text: string; escalate: boolean; snoozeHours: number | null } {
    let text = raw;
    let escalate = false;
    let snoozeHours: number | null = null;

    const match = text.match(/\[(ESCALATE|SNOOZE:(\d{1,4}))\]\s*$/i);
    if (match) {
        text = text.slice(0, match.index).trim();
        if (/^ESCALATE$/i.test(match[1])) escalate = true;
        else snoozeHours = Math.max(1, parseInt(match[2], 10));
    }
    return { text, escalate, snoozeHours };
}

function fallbackMessage(state: DocState, magicLink: string | null, turnType: TurnType): string {
    const advisor = state.advisorName ?? "your Credit Banc advisor";
    const link = magicLink ? ` Upload here: ${magicLink}` : " Just log in to your Credit Banc portal to upload.";
    if (turnType === "reply") {
        return `Thanks for your message! I'll have ${advisor} follow up with you shortly. In the meantime you can upload any outstanding documents in your portal.${magicLink ? ` ${magicLink}` : ""}`;
    }
    const docCount = state.outstandingDocs.length;
    return `Hi ${state.clientFirstName}, it's Ava with Credit Banc working with ${advisor}. We still need ${docCount === 1 ? "one document" : `${docCount} documents`} to keep your funding moving.${link}`;
}
