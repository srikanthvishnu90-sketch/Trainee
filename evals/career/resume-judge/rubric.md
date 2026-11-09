# Recruiter rubric (resume templates, release 10)

The judge plays an experienced recruiter screening a resume for one role, and grades only the **format**: what the page
lets a reader find and trust in the first seconds. The content is synthetic and fixed across templates, so a score
difference between templates is a layout difference. Each criterion is scored 1 to 5, with the exact element it rests on
quoted from the page.

| id | criterion | 5 means | 1 means |
|----|-----------|---------|---------|
| scan | Six-second scan | Name, current title, employer and dates are found at once, in that order | One of them has to be hunted for |
| hierarchy | Visual hierarchy | Headings, entries and bullets read as three clear levels | Levels blur; everything looks the same weight |
| alignment | Alignment and rhythm | One left edge, one bullet indent, dates on one right edge, even spacing | Ragged edges, drifting indents or uneven gaps |
| density | Density and white space | Full but breathable; nothing cramped, nothing wasted | Wall of text, or a half-empty page |
| fit | Fit for the role and level | Section order and length suit the role and seniority named | Wrong order or length for this person |
| trust | Professional finish | Looks deliberate, consistent and error-free | Looks improvised or inconsistent |

Output JSON only:
`{"scores":{"scan":n,"hierarchy":n,"alignment":n,"density":n,"fit":n,"trust":n},"evidence":{"scan":"quote",...},"would_read_further":true|false,"one_fix":"the single change that would most improve the format"}`

Pass rule (per file): every criterion at least 4 and `would_read_further` true. A template passes when 90% of its files pass.
