// EVAL ONLY (evals/career/tasks/agent-import-map.json): agent-chat/career_brain.ts with its release pin lifted, so the
// task-completion eval can measure CAREER_BRAIN=agent through the real handler in its own process. Nothing in
// production imports this file or that import map; production keeps AGENT_BRAIN_RELEASED = false.
export * from "../../../../supabase/functions/agent-chat/career_brain.ts";
export const AGENT_BRAIN_RELEASED = true;
