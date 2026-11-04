// agent-chat entry: Trainee career chat only. The Upmore finance entry (handler.ts and its answer modules) was removed on
// 2026-10-28. Deploys stage index-career.ts as this file (scripts/career/stage-career.cjs); the two stay identical.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { handleChat } from "./handler-career.ts";

serve(handleChat);
