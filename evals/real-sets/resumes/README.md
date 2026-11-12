# Item 3, resumes: 35 real postings × the fictional persona

**Result on trunk 7bbf6512 (2026-11-12, $0): PASS 35/35 postings (bar 34/35), invented facts 0.** 70 files: opens 70/70, copies
70/70, downloads 70/70, pages 70/70, target 70/70, nothing invented 70/70. 24 of the 35 postings name a skill the persona's
confirmed record states, and every file prints it.

## What runs

Each posting in `../postings` goes through the real tailor path: the brain's `tailor_resume` tool, called with the posting's
`job_id`. The store serves the row as handler-career serves `postingsDb.get`, and the PDF and the Word copy are handed over
through `deliver`, as a reply attaches them. The persona is Alex Testcase (TEST), `packages/career-data/fixtures/test-resume.txt`,
with every fact confirmed. No model is called (the tailor is code) and nothing touches the network.

A posting passes when both files pass every check:

| Check | What is checked |
|---|---|
| opens | poppler and pdfminer.six parse the PDF; the DOCX unzips and python-docx opens it |
| copies | the copied text has the name and email in every parser, with no unmapped glyphs |
| downloads | base64 decodes; the magic bytes are right; the PDF's sha256 equals the tool's; the filename is safe and ends .pdf or .docx; the MIME type is right |
| pages | the page count is within what the layout promises |
| target | the job_id is this posting's, and every skill the posting names that the confirmed record states as a whole word is printed |
| invented | `inventedIn` (the resume loop's truth-guard token rule) finds nothing, on all three texts |

The resume loop's own target rule, which trusts `CareerProfile.skillEvidence`, is reported as `loop_rule`: 23/35. On these real
postings it asks the file to print "R" and "SQL", which the persona never stated (`../README.md`, finding 1). Printing them would
be inventing, so that rule is reported and is not the bar. After D-069 (skills matched as whole tokens and known aliases) it is
35/35, with no unprinted skill; the bar result is unchanged at 35/35.

`CI=true deno run -A --no-check evals/real-sets/resumes/run.ts [--out DIR]` writes `results/latest.json`. It needs poppler,
pdfminer.six and python-docx, the ones the resume loop needs.

Not covered: real resumes of real people (B in VERIFICATION-15 still needs consent), and the visual design checks
(`scripts/resume-design-loop.ts`, which needs LibreOffice rendering).
