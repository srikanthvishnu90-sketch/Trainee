// The actions trainee-file/handler.ts answers on a File page (its POST dispatch: the results list's action guard). A File family is
// drawn with these as Ctx.routes, so a control that would post anything else is shown disabled with its reason, never as a live
// button (R10 "no dead buttons"). tests/architect/r10-no-dead-buttons.test.ts holds this list equal to the handler's own guard.
export const FILE_ROUTES: ReadonlySet<string> = new Set(["apply", "applysel", "applyall", "answer", "refresh", "dismiss", "restore", "pause", "resume"]);
