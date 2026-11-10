-- x-audit (20261110170000): the card-cloud validator accepts page_field_values (the employer's hidden-field values the
-- approval binds) only in its one shape, and a payload without it validates as before. Read-only; nothing is written.
do $$
declare names jsonb := '["job_id","source","authenticity_token"]'::jsonb;
  ok boolean;
begin
  -- absent: unchanged
  if not career_message_approval_private.cloud_page_values_ok(jsonb_build_object('page_field_names', names)) then raise exception 'FAIL a payload without page_field_values'; end if;
  -- the shape: a non-empty object of strings, each a named page field, none a per-load token
  if not career_message_approval_private.cloud_page_values_ok(jsonb_build_object('page_field_names', names, 'page_field_values', '{"job_id":"4012","source":"careers-page"}'::jsonb)) then raise exception 'FAIL the valid shape'; end if;
  for ok in select career_message_approval_private.cloud_page_values_ok(x) from (values
      (jsonb_build_object('page_field_names', names, 'page_field_values', '{}'::jsonb)),                                 -- empty
      (jsonb_build_object('page_field_names', names, 'page_field_values', '["job_id"]'::jsonb)),                         -- not an object
      (jsonb_build_object('page_field_names', names, 'page_field_values', '{"job_id":4012}'::jsonb)),                    -- not a string
      (jsonb_build_object('page_field_names', names, 'page_field_values', '{"utm":"x"}'::jsonb)),                        -- not a named field
      (jsonb_build_object('page_field_names', names, 'page_field_values', '{"authenticity_token":"abc"}'::jsonb)),       -- a per-load token
      (jsonb_build_object('page_field_names', '["g-recaptcha-response"]'::jsonb, 'page_field_values', '{"g-recaptcha-response":"t"}'::jsonb)),
      (jsonb_build_object('page_field_names', names, 'page_field_values', jsonb_build_object('job_id', repeat('x', 4001))))  -- too long
    ) v(x) loop
    if ok then raise exception 'FAIL a malformed page_field_values was accepted'; end if;
  end loop;
  raise notice 'ok   page_field_values: absent or one shape (strings, named fields, no per-load token); 7 malformed shapes refused';
  -- the validator allows the key and calls the check
  if not exists (select 1 from pg_proc where proname = 'cloud_validate' and prosrc like '%''page_field_values''%' and prosrc like '%cloud_page_values_ok(p)%') then
    raise exception 'FAIL cloud_validate does not allow and check page_field_values'; end if;
  -- no client can run either function
  if has_function_privilege('authenticated', 'career_message_approval_private.cloud_page_values_ok(jsonb)', 'execute')
     or has_function_privilege('anon', 'career_message_approval_private.cloud_page_values_ok(jsonb)', 'execute') then
    raise exception 'FAIL a client can run cloud_page_values_ok'; end if;
  raise notice 'ok   cloud_validate allows the key only through the check; no client can run it';
end $$;
