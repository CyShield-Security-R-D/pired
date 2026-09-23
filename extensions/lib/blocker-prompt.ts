import { APPROVE_OPTION, blockerDialog, DENY_OPTION, SKIP_OPTION, type DialogViewport } from "../../core/dialog.ts";
import type { BlockerRecord } from "../../core/ontology.ts";

interface BlockerPrompter {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** Dismissal is not a decision. Only an explicit answer can settle a blocker. */
export async function promptBlocker(ui: BlockerPrompter, blocker: BlockerRecord, viewport?: Partial<DialogViewport>): Promise<string | undefined> {
	const dialog = blockerDialog(blocker, viewport);
	const picked = dialog.shape === "select"
		? await ui.select(dialog.title, dialog.options ?? [])
		: await ui.input(dialog.title, dialog.placeholder);
	if (blocker.type === "approval") {
		if (picked === APPROVE_OPTION) return "approved";
		if (picked === DENY_OPTION) return "denied";
		return undefined;
	}
	return picked && picked !== SKIP_OPTION ? picked : undefined;
}
