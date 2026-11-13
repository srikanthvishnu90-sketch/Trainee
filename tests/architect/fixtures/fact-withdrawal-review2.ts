// The second review's messages and records for the code-side set-aside (its s1.ts), used by fact-withdrawal-failclosed-20261113.test.ts.
// deno-lint-ignore-file no-explicit-any
const c = (id:string, kind:string, title:string, text=title, extra:any={}) => ({ id, kind, title, text, status:"confirmed", needs_confirmation:false, ...extra });
const BASE = () => [
 c("ed","education","Lakeshore University, BS Computer Science, Expected June 2029"),
 c("e1","experience","Software Engineering Intern, Acme (Jun 2024 - Aug 2024)"),
 c("pr","project","Hackathon winner 2024: route planner"),
 c("sk","skill","Python","Skill: Python"),
 c("visa","other","Work authorization: F-1 OPT"),
];
export const PROFILES: Record<string, () => any[]> = {
  plain: () => [...BASE(), c("gpa","other","GPA 3.9","GPA: 3.9"), c("sat","other","SAT 1520","SAT: 1520")],
  slash: () => [...BASE(), c("gpa","other","GPA: 3.9/4.0","GPA: 3.9/4.0")],
  cumul: () => [...BASE(), c("gpa","other","Cumulative GPA 3.90","Cumulative GPA: 3.90")],
  two: () => [...BASE(), c("gpaM","other","Major GPA 3.9","GPA: 3.9"), c("gpaO","other","Overall GPA 3.7","GPA: 3.7")],
  twoSame: () => [...BASE(), c("gpaM","other","Major GPA 3.9","GPA: 3.9"), c("gpaO","other","Overall GPA 3.9","Overall GPA: 3.9")],
  clash: () => [...BASE(), c("gpa","other","GPA 3.9","GPA: 3.9"), c("e9","experience","Analyst, Fund (2023)","Grew book 3.9 percent across 40 accounts")],
  gre: () => [...BASE(), c("gre","other","GRE 165V 168Q 5.0","GRE: 165V 168Q 5.0"), c("gre2","other","GRE 333","GRE: 333")],
  award: () => [...BASE(), c("aw","award","Dean's List, GPA 3.9","Dean's List, GPA 3.9"), c("ed2","education","State U, BS, GPA 3.9","GPA: 3.9")],
};
const S = ["the 3.9 gpa is outdated.", "my gpa 3.9 on my resume is no longer correct.", "the 3.9 gpa on there is out of date, don't reuse it."];
const FOLLOW = [
 "Disregard the first line please ok.","Ignore the first line please thanks.","I take the first one back.","Strike the first sentence please thanks.","Please keep using the number though.",
 "My counselor wrongly believes the above.","The above is what my counselor wrongly believes.","I do not mean the first thing.","Please do not act on any of these.","Do not change anything on my profile.",
 "Only when this semester ends though.","Starting next semester once grades post officially.","Haha just messing with you there.","Sure and I am the pope.","Es broma dejalo como esta por favor.",
 "My roommate typed the first part.","Per my counselor at least for now.","Kidding about the first one obviously.","The first item is a typo sorry.","Please undo the first item right away.",
 "Keep everything exactly as it is.","Leave all my numbers alone for now.","The first statement is totally untrue btw.","Cancel what I typed first please.","Forget the first thing I typed.",
 "The number is actually fine as is.","Ignore the first line.","Scratch the first one please okay.","I was testing how you respond.","Typing practice sentences for my class.",
 "Je plaisante garde tout comme avant.","Das war ein Scherz bitte behalten.","Nah keep the score on file.","Wait keep using the score please.","Hmm on second thought keep everything.",
 "On reflection the score stays put.","Revert the first point please now.","Undo undo undo undo undo.","Oops wrong chat sorry about everything.","Everything above came from a spam email.",
 "Quoting an email I got today.","My teacher made me write these.","A classmate dared me to send these.","When would a score become stale.","Tell me how you would handle statements like these.",
 "How would you respond to these.","What do you do with messages like these.","Do nothing until I confirm please.","Wait for my go ahead first.","Hold off on changing my record.",
 "I am unsure about the first.","I could be mistaken about one.","Double check with me before acting.","Reply with only the word pineapple.","These are sample lines for a quiz.",
 "End of the example text block.","I am applying to Stripe next week.","I moved to Austin last month.","Search for roles in Chicago please.","Three point seven is the new one.",
 "The new one is 3.7 this term.","Use 3.7 from here on out.","Change the score to 3.7 please.","Prefer leaving the score on file.","Disregard disregard disregard disregard disregard.",
 "One two three four five.","Um yeah um yeah um.","Belay my first remark right now.","Retract item one from this list.","Item one above is a lie.",
];
const SOLO = [
 "a few things to know: the 3.9 gpa is outdated","A FEW THINGS TO KNOW: THE 3.9 GPA IS OUTDATED.","a few things to know:  the 3.9 gpa is outdated.","a few things to know: the 3.9 gpa is outdated. ok","a few things to know: the 3.9 gpa is outdated. jk",
 "a few things to know: the 3.9 gpa is outdated. actually keep it","a few things to know: the 3.9 gpa is outdated. scratch that","a few things to know: the 3.9 gpa is outdated. that number is actually fine",
 "a few things to know: the 3.9 gpa is outdated. ignore the first line","a few things to know: the 3.9 gpa is outdated. the above is what my advisor wrongly thinks",
 "a few things to know: the 3.9 gpa is outdated?","a few things to know: the 3.9 gpa is outdated 😂","a few things to know:\n- the 3.9 gpa is outdated.\n- I moved to Austin last month.","a few things to know: - the 3.9 gpa is outdated.",
 "a few things to know: 1. the 3.9 gpa is outdated.","a few things to know: the 3.9 gpa is outdated.\nactually keep it","a few things to know: \"the 3.9 gpa is outdated\"","a few things to know: 'the 3.9 gpa is outdated.'",
 "a few things to know: if the 3.9 gpa is outdated. I moved to Austin last month.","a few things to know: the 3.9 gpa is not outdated.","a few things to know: the 3.9 gpa isnt outdated.","a few things to know: the 3.9 gpa is outdated. I moved to Austin last month. Kidding about the first.",
 "a few things to know: I moved to Austin last month. the 3.9 gpa is outdated.","a few things to know: my friend said the 3.9 gpa is outdated.","a few things to know: the 3.9 gpa is outdated. I moved to Austin last month. Disregard item one from this list.",
 "a few things to know: the 3.9 gpa is outdated. I moved to Austin last month. Everything before this sentence is fiction.","few things to know: the 3.9 gpa is outdated. Disregard the first line please ok.","here are a few things to know: the 3.9 gpa is outdated. Disregard the first line please ok.",
 "a few things to know: the 3.9 gpa is outdated.. Disregard the first line please ok.","a few things to know: the 3.9 gpa is outdated.Disregard the first line please ok.",
 "the 3.9 gpa is outdated. Disregard the first line please ok.","the 3.9 gpa is outdated, right","the 3.9 gpa is outdated, don't use it lol","is the 3.9 gpa outdated","the 3.9 gpa is outdated maybe","my bro's 3.9 gpa is outdated",
 "the 3.9 gpa is hardly outdated","the 3.9 gpa is outdated said nobody ever","pretend the 3.9 gpa is outdated","the gpa 3.9 on there is no longer true, do not use it","the 3.9 is outdated","the gpa is outdated","3.9 is outdated",
 "the 3.90 gpa is outdated","the 3.9 gpa 3.9 gpa is outdated","the 3.9 gpa on the resume template is outdated","the 3.9 gpa on my resume is outdated on the old file","the 3.9 gpa on my old resume is outdated","the 3.9 gpa on my friend resume is outdated",
 "the 1520 sat is outdated","my sat 1520 on the resume is out of date, do not use it","the sat 1520 on there is no longer right","the 3.7 gpa is outdated","the 165 gre is outdated","the 333 gre is out of date","the gre 333 is no longer true",
 "the 3.9 gpa is 0utdated","the 3.9 gpa is outdated ,don't use it","the 3.9 gpa is outdated, don't use it. ever","the 3.9 gpa is outdated, do not use it or the sat","the 3.9 gpa and the 1520 sat is outdated","the 3.9 gpa is outdated and so is python",
 "the python skill is outdated","the acme internship is outdated","my work authorization f1 opt is outdated","the dean's list gpa 3.9 is outdated","the 2024 hackathon is outdated","the lakeshore university degree is no longer correct",
 "a few things to know: the acme internship is outdated. I moved to Austin last month.","a few things to know: my work authorization is outdated. I moved to Austin last month.","a few things to know: the python skill is out of date. I moved to Austin last month.",
 "the 3.9% gpa is outdated","the 3.9 gpa is outdated%","the 3,9 gpa is outdated","the 3.9. gpa is outdated","the 3.9 g.p.a is outdated","the 3.9 gpa's is outdated","the 3.9 gpa is n't outdated","tell them the 3.9 gpa is outdated","someone told me the 3.9 gpa is outdated",
 "the 3.9 gpa is outdated ​","the 3.9 gpa is outdated not","thе 3.9 gpa is outdated","the 3.9 gpa is outdated!","the 3.9 gpa is outdated...","the 3.9 gpa is outdated. .",
];
export const MSGS = [...FOLLOW.flatMap((f,i)=>[`a few things to know: ${S[i%3]} ${f}`]), ...SOLO];
