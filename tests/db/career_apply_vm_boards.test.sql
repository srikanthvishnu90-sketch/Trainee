-- 20261110120000: the VM's boards in SQL, the same verdicts as apply-vm.cjs atsOf (tests/career-apply-vm-boards.test.cjs).
do $$
declare c record; got text;
begin
  for c in select * from (values
    ('https://acme.breezy.hr/p/1', 'breezy'), ('https://x.jobs.personio.de/job/1', 'personio'), ('https://jobs.lever.co/a/1', 'lever'),
    ('https://www.jobs.lever.co/a', 'lever'), ('https://boards.greenhouse.io/a', 'greenhouse'), ('https://job-boards.greenhouse.io/a/jobs/1', 'greenhouse'),
    ('https://jobs.lever.co:8443/a', 'unsupported'), ('https://breezy.hr/p', 'unsupported'), ('https://a.b.breezy.hr/p', 'unsupported'),
    ('https://acme.breezy.hr.evil.com/p', 'unsupported'), ('https://evil-breezy.hr/p', 'unsupported'), ('https://acme.jobs.personio.de.evil.io/', 'unsupported'),
    ('https://acme.jobs.personio.com/', 'unsupported'), ('https://-x.breezy.hr/', 'unsupported'), ('https://jobs.ashbyhq.com/acme/1', 'unsupported'),
    ('https://www.linkedin.com/jobs/1', 'refused'), ('https://jobs.linkedin.com/x', 'refused'), ('https://acme.myworkdayjobs.com/x', 'account_gated')
  ) v(url, fam) loop
    got := public.career_apply_vm_family(c.url);
    if got is distinct from c.fam then raise exception 'FAIL career_apply_vm_family(%) = %, want %', c.url, got, c.fam; end if;
    if public.career_apply_vm_claimable(c.url) is distinct from (c.fam in ('greenhouse', 'lever', 'personio', 'breezy')) then raise exception 'FAIL claimable(%)', c.url; end if;
  end loop;
  raise notice 'ok   career_apply_vm_boards: 18 links, the four boards by exact host, look-alikes unsupported, the denylist first';
end $$;
