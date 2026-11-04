-- FEATURE 16 (20261026220016_channel_telegram_login.sql): Telegram's login links a chat to one account, once. The hash
-- and the sign-in's age are checked by the edge function (_shared/telegram_login.ts); here the database refuses a replay,
-- a Telegram user already on another account, an account already holding another Telegram user, and stale or future
-- sign-ins; a chat's channel-only sign-up account hands the chat over; unlinking lets the chat go.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-0000000016a1','web-a@example.test'),
 ('00000000-0000-4000-8000-0000000016a2','web-b@example.test'),
 ('00000000-0000-4000-8000-0000000016a3','tg-555000333@users.trainee.invalid');
insert into channel_contacts(contact,user_id,created_at,updated_at) values ('tg:555000333','00000000-0000-4000-8000-0000000016a3',now(),now());
set role service_role;
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a1','555000111',repeat('1',64),now() - interval '1 minute',now())->>'outcome' = 'linked'), 'a fresh signed sign-in links the chat');
select t.ok((select user_id = '00000000-0000-4000-8000-0000000016a1' and channel = 'telegram' from channel_contacts where contact = 'tg:555000111'), 'the chat is the person''s');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a1','555000111',repeat('1',64),now() - interval '1 minute',now())->>'error' = 'replay'), 'the same signed payload again is a replay, refused');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a2','555000111',repeat('2',64),now(),now())->>'error' = 'linked_elsewhere'), 'a second account cannot claim a Telegram user already linked');
select t.ok((select user_id = '00000000-0000-4000-8000-0000000016a1' from channel_contacts where contact = 'tg:555000111'), 'and the chat stays where it was');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a1','555000222',repeat('3',64),now(),now())->>'error' = 'account_has_other'), 'one account holds one Telegram user');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a1','555000111',repeat('4',64),now(),now())->>'outcome' = 'already'), 'the same pair again is already linked');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a2','555000444',repeat('5',64),now() - interval '11 minutes',now())->>'error' = 'stale'), 'a sign-in over 10 minutes old is refused');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a2','555000444',repeat('6',64),now() + interval '5 minutes',now())->>'error' = 'future'), 'a sign-in dated in the future is refused');
select t.ok((select count(*) = 0 from channel_contacts where contact = 'tg:555000444'), 'nothing linked by a refused sign-in');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a2','555000333',repeat('7',64),now(),now()) @> '{"outcome":"linked","moved_from":"00000000-0000-4000-8000-0000000016a3"}'::jsonb),
 'a chat on its channel-only sign-up account is handed to the account the person signed in with');
select t.ok((select user_id = '00000000-0000-4000-8000-0000000016a2' from channel_contacts where contact = 'tg:555000333'), 'it is theirs now');
select t.ok((select channel_telegram_unlink_as('00000000-0000-4000-8000-0000000016a1', now()) = 1), 'unlink lets the chat go');
select t.ok((select user_id is null from channel_contacts where contact = 'tg:555000111'), 'the chat belongs to no account');
select t.ok((select channel_telegram_unlink_as('00000000-0000-4000-8000-0000000016a1', now()) = 0), 'nothing to unlink twice');
select t.ok((select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a1','555000222',repeat('8',64),now(),now())->>'outcome' = 'linked'), 'after unlinking, another Telegram user links');
-- A channel-only account (the chat's own sign-up) is never unlinked from its chat: that would strand both.
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000016a4','tg-555000444@users.trainee.invalid');
insert into channel_contacts(contact,user_id,created_at,updated_at) values ('tg:555000444','00000000-0000-4000-8000-0000000016a4',now(),now());
set role service_role;
select t.ok((select channel_telegram_unlink_as('00000000-0000-4000-8000-0000000016a4', now()) = -1), 'a channel-only account is not unlinked from its chat (-1)');
select t.ok((select user_id = '00000000-0000-4000-8000-0000000016a4' from channel_contacts where contact = 'tg:555000444'), 'and the chat is still its account');
-- A chat moved off its channel-only account (555000333, to 16a2) and then unlinked comes back to that account on reattach.
select t.ok((select channel_telegram_unlink_as('00000000-0000-4000-8000-0000000016a2', now()) = 1), 'the web account unlinks the chat it took over');
select t.ok((select channel_telegram_reattach_as('tg:555000333', now()) = '00000000-0000-4000-8000-0000000016a3'), 'the chat returns to its own channel-only account');
select t.ok((select user_id = '00000000-0000-4000-8000-0000000016a3' from channel_contacts where contact = 'tg:555000333'), 'recorded');
select t.ok((select channel_telegram_reattach_as('tg:555000111', now()) is null), 'a chat with no channel-only account of its own is not reattached');
select t.ok((select channel_telegram_reattach_as('tg:555000222', now()) is null), 'nor 555000222, which has no sign-up account of its own');
select t.ok((select user_id = '00000000-0000-4000-8000-0000000016a1' from channel_contacts where contact = 'tg:555000222'), 'which stays theirs');
reset role;
set role authenticated;
select t.must_fail($$select channel_telegram_link_as('00000000-0000-4000-8000-0000000016a1','555000999',repeat('9',64),now(),now())$$, 'permission denied', 'a signed-in person cannot call the link directly');
select t.must_fail($$select channel_telegram_unlink_as('00000000-0000-4000-8000-0000000016a2', now())$$, 'permission denied', 'nor unlink anyone');
select t.must_fail($$select * from channel_telegram_logins$$, 'permission denied', 'nor read the used sign-ins');
select t.must_fail($$select channel_telegram_reattach_as('tg:555000333', now())$$, 'permission denied', 'nor reattach a chat');
rollback;
