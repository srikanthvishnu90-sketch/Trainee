// CAREER_APPLY_ALL_YES: the one definition of the apply-all-by-yes switch, used by the chat handler (agent-chat/release_config.ts), the
// results page (trainee-file/handler.ts) and apply_all_yes.ts. "off" (anything but "on"; unset is on) leaves no question or offer in the
// results message, no yes handling, no page button, and the page's applyall action refuses.
export const APPLY_ALL_YES_ENV = "CAREER_APPLY_ALL_YES";
export const applyAllYesEnabled = (env: { get(k: string): string | undefined }): boolean => (env.get(APPLY_ALL_YES_ENV) ?? "on").trim().toLowerCase() === "on";
