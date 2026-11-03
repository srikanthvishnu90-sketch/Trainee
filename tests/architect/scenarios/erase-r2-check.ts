// Erase scenarios, round 2: what a reply about an account deletion may say, checked claim by claim against the result and,
// when known, the truth (the account is gone or not). Shared by scenarios-erase-r2.test.ts and flow-scenarios-erase-r2.test.ts.
import { GOOGLE_PERMISSIONS } from "../../../supabase/functions/_shared/account_delete.ts";
import { MICROSOFT_NOTE } from "../../../supabase/functions/_shared/outlook_connector.ts";

export interface Said { deleted: boolean; google: Record<string, string>; outlook: boolean; failures: string[]; grantsRead: boolean; disconnected?: boolean; had?: string[] }
export const TOKENISH = /\bya29\.|1\/\/FAKE|EwBFAKE|M\.FAKE|refresh_token|access_token|\b[A-Z]{2,}(?:_[A-Z]{2,})+\b|undefined|\bnull\b|\[object/;

export function wordsWhy(r: Said, x: string, truth?: { gone: boolean }): string | null {
  if (TOKENISH.test(x)) return "a token, an internal code or a placeholder in the reply";
  if (truth && r.deleted !== truth.gone) return `deleted=${r.deleted} but the account is ${truth.gone ? "gone" : "still there"}`;
  if (r.deleted !== /^Your Trainee account is deleted:/.test(x)) return r.deleted ? "a deleted account is said deleted, first" : "never \"deleted\" before it is";
  if (!r.deleted && !/^Your Trainee account was not deleted\b/.test(x)) return "an account still there is said not deleted, first";
  if (!r.deleted && /\bis deleted\b|\bare gone\b/.test(x)) return "never \"deleted\" or \"gone\" while the account is there";
  if (/already disconnected/.test(x) && !(r.disconnected && r.had?.length)) return "never \"already disconnected\" unless the connections were deleted";
  if (!r.deleted && r.disconnected && r.had?.length && !/already disconnected/.test(x)) return "an account kept but disconnected says so";
  const g = Object.values(r.google);
  const confirmed = g.length > 0 && g.every((o) => o === "revoked");
  if (/Google confirmed/.test(x) !== confirmed) return confirmed ? "Google answered 200 for every grant: say it confirmed" : "never \"Google confirmed\" a revoke Google did not confirm";
  if ((g.length && !confirmed) || !r.grantsRead) { if (!x.includes(GOOGLE_PERMISSIONS)) return "an unconfirmed revoke says where to remove access by hand"; }
  else if (x.includes(GOOGLE_PERMISSIONS)) return "no unconfirmed Google revoke: no instructions to remove it by hand";
  if (r.outlook !== x.includes(MICROSOFT_NOTE)) return r.outlook ? "an Outlook grant says where to remove the app (Microsoft has no revoke)" : "no Outlook grant: no Microsoft note";
  if (/Microsoft confirmed|Outlook access (?:is|was) revoked|revoked your Outlook/i.test(x)) return "never a Microsoft revoke";
  const rest = r.failures.filter((f) => !/^check which Google/.test(f) && f !== "delete your account");
  if (r.deleted && rest.length && !/couldn't confirm/.test(x)) return "what could not be done is said";
  if (r.deleted && !rest.length && /couldn't confirm/.test(x)) return "nothing failed: nothing said to have failed";
  return null;
}
