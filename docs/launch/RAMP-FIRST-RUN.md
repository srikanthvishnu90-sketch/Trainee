# The owner's first real application: Ramp, Software Engineering Intern, Frontend (Ashby)

Posting: https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74. Nothing here has been run against Ramp.
The owner sends it himself, from Telegram, and approves the exact card; nothing goes to Ramp before that tap.

## What the form asks, and where each answer comes from

Ramp's form here is RECONSTRUCTED, not captured (`tests/fixtures/ramp/ashby-ramp-a13ae586-reconstructed.html`): the field
list was read from the live page in the owner's browser on 2026-10-25; the markup is the captured Ashby forms'. The dry run
on it (`RAMP_PERSONA=<file outside the repo> deno test ... tests/architect/flow-hosted-apply.test.ts`) put on the card:

| Field | Required | Comes from |
|---|---|---|
| Full Legal Name | yes | his answer, asked once |
| Email | yes | his answer, asked once |
| Phone | yes | his answer, asked once |
| SMS consent, WhatsApp consent (radios) | no | **his own answer, asked once**; never given on his behalf |
| Resume | yes | the file he sends, byte for byte, by its sha256 |
| School (search box) | yes | his answer, asked once |
| What is your graduation date? (MM/DD/YYYY) | yes | **his answer with the day**; "June 2029" has no day, and Trainee never adds one |
| Located in, or willing to relocate to, Greater NYC | yes | his answer (Yes) |
| Requesting visa sponsorship? | yes | his answer (No) |
| Share something you've built that you're proud of. | yes | his answer (the Sporv text) |
| Pronouns, LinkedIn Profile, Degree, Field of Study, start/end month and year, Still Student? | no | left empty: optional, and no answer of his was mapped to them |

## The run

0. Before it: the architect's dry run on the live page (`scripts/career/ramp-dry-run.ts`, never submits) and the trace,
   with what he provides and every setting by submitter: docs/architect/RAMP-APPLY-TRACE-2026-10-31.md. Whichever sends it,
   its host needs `UPMORE_SCRIPT_SUBMIT_LIVE=1` (Ashby has no form post); without it no card is ever prepared.
1. Go-live with the hosted runner wired (docs/launch/CLOUD-RUNNER.md), the resume rule and Telegram card buttons from #194.
2. Choose option (a) or (b) in CLOUD-RUNNER.md, "The owner's Ramp run and the gate".
3. In Telegram: send the resume file, say it is his, then "apply me to this: <the link>". Answer the questions by number.
4. Read the card. Tap Approve only if every line is right.

## Verification queries (read only; `<me>` is his user id)

```sql
-- The job: state, who sent it, the hashes, the employer's response code, the page's confirmation, the email's.
select id, state, source, attempts, payload_hash, approval_hash, payload->>'engine_approval' as engine_approval,
       payload->>'resume_sha256' as resume_sha256, claimed_at, confirmation_id, email_confirmed_at, confirmation_mail_hash,
       evidence->'response'->>'status' as employer_status, evidence->'response'->>'destination' as destination,
       evidence->'response'->>'final_url' as final_url, evidence->>'page_confirmation' as page_confirmation,
       evidence->'screenshots'->'sha256' as screenshot_sha256, evidence->'proof' as own_computer_proof, reason
from career_apply_jobs where user_id = '<me>' and url like '%a13ae586-f4cb-4385-8822-c42b9b54ed74%';

-- The hashes agree: the job is the card's item, the payload hashes to itself, the resume sent is the one kept.
select j.payload_hash = j.approval_hash as approved_as_hashed,
       j.payload_hash = public.career_apply_payload_hash(j.payload) as payload_intact,
       exists (select from career_apply_cards c, jsonb_array_elements(c.items) it
               where c.user_id = j.user_id and c.state = 'answered' and it->>'payload_hash' = j.payload_hash) as from_his_card,
       exists (select from career_apply_cloud_resumes r where r.user_id = j.user_id and r.sha256 = j.payload->>'resume_sha256'
               and encode(sha256(r.bytes), 'hex') = r.sha256) as resume_kept_intact,
       (select row_to_json(t) from career_apply_cloud_text_claims t where t.job_id = j.id) as cloud_text_claim
from career_apply_jobs j where j.user_id = '<me>' and j.url like '%a13ae586%';

-- The card he approved, and the answer he gave it.
select c.id, c.state, c.shown_at, c.answered_at, c.answer, o.status, o.contact, o.provider_id, o.delivered_at
from career_apply_cards c left join career_outbox o on o.card_id = c.id
where c.user_id = '<me>' order by c.shown_at desc limit 3;

-- The receipt: queued once, delivered to his Telegram chat, with Telegram's message id.
select o.key, o.kind, o.status, o.contact, o.provider_id, o.delivered_at, o.text
from career_outbox o join career_apply_jobs j on o.key = 'receipt:' || j.id
where j.user_id = '<me>' and j.url like '%a13ae586%';

-- The cloud's own record of it (option b), and the gate after (option a counts only once confirmed by email).
select outcome, error_kind, portal, at from career_apply_cloud_events e join career_apply_jobs j on j.id = e.job_id
where j.user_id = '<me>' and j.url like '%a13ae586%';
select career_apply_cloud_open('ashby') as ashby_gate_open;

-- The preparation that made the card: its request, outcome and the time from his message to the card.
select id, state, created_at, claimed_at, finished_at, finished_at - created_at as took, outcome, card_id
from career_apply_prepare_requests where user_id = '<me>' order by created_at desc limit 3;
```

Read "sent" only from `state` in (`submitted_unconfirmed`, `confirmed`) with an `employer_status` of 2xx or 3xx;
"confirmed" only with `email_confirmed_at` set. A `needs_user` / `bot_check` row means a verification check stopped it and
nothing reached Ramp: he finishes it himself at the link, as the receipt says.
