-- Reverse of 20261112130000_career_postings_pay_zones.sql: the zones column and its shape check gone (pay, the text, is untouched).
alter table public.career_postings drop constraint if exists career_postings_pay_zones_shape;
alter table public.career_postings drop column if exists pay_zones;
