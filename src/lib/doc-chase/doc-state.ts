// Doc-Chase Agent ("Ava") — live document-state read.
//
// Computes outstanding docs from the normalized tables (client_dynamic_documents
// + required_documents + user_documents) via the same engine the reminder email
// uses, so Ava is always self-correcting:
//   • A doc counts as satisfied on upload (user_documents.status != 'rejected'),
//     so Ava stops asking the moment the client sends it.
//   • If the team later rejects the upload, it becomes outstanding again and
//     Ava picks it back up automatically.
// The denormalized client_data_vault.outstanding_documents array is NOT used.

import { createAdminClient } from "@/lib/supabase/admin";
import { calculateOutstandingDocumentsByBusiness } from "@/lib/outstanding-documents";

export interface DocRef {
    code: string;
    label: string;
}

export interface DocState {
    clientVaultId: string;
    userId: string;
    clientFirstName: string;
    clientEmail: string;
    advisorName: string | null;
    loanType: string | null;
    ghlContactId: string | null;
    /** Requested and not yet uploaded. */
    outstandingDocs: DocRef[];
    /** Requested and already uploaded (not rejected). */
    receivedDocs: DocRef[];
}

interface VaultRow {
    id: string;
    user_id: string;
    client_name: string | null;
    client_email: string;
    advisor_name: string | null;
    proposed_loan_type: string | null;
    ghl_contact_id: string | null;
}

export async function getDocState(clientVaultId: string): Promise<DocState | null> {
    const supabase = createAdminClient();

    const { data: vault } = await supabase
        .from("client_data_vault")
        .select("id, user_id, client_name, client_email, advisor_name, proposed_loan_type, ghl_contact_id")
        .eq("id", clientVaultId)
        .maybeSingle<VaultRow>();
    if (!vault) return null;

    // All requested docs (active rows), de-duped by code.
    const { data: dynamicDocs } = await supabase
        .from("client_dynamic_documents")
        .select("required_documents ( code, label )")
        .eq("user_id", vault.user_id)
        .eq("is_active", true);

    const requested = new Map<string, string>(); // code -> label
    (dynamicDocs ?? []).forEach((row: any) => {
        const def = Array.isArray(row.required_documents) ? row.required_documents[0] : row.required_documents;
        if (def?.code) requested.set(def.code, def.label);
    });

    const { flatDocs: outstandingDocs } = await calculateOutstandingDocumentsByBusiness(vault.user_id);
    const outstandingCodes = new Set(outstandingDocs.map(d => d.code));

    const receivedDocs: DocRef[] = [];
    requested.forEach((label, code) => {
        if (!outstandingCodes.has(code)) receivedDocs.push({ code, label });
    });

    return {
        clientVaultId: vault.id,
        userId: vault.user_id,
        clientFirstName: (vault.client_name || "").trim().split(/\s+/)[0] || "there",
        clientEmail: vault.client_email,
        advisorName: vault.advisor_name?.trim() || null,
        loanType: vault.proposed_loan_type || null,
        ghlContactId: vault.ghl_contact_id,
        outstandingDocs,
        receivedDocs,
    };
}
