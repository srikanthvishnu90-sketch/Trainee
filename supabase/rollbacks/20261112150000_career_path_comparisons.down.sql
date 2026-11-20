-- Rollback of 20261112150000_career_path_comparisons.sql (D-072, files writers). Drops the path comparisons and their guard. The
-- F-03 Path comparison File then has no record to be drawn from and says "nothing on record", as before.
drop table if exists public.career_path_comparisons cascade;
drop function if exists public.career_path_comparisons_guard();
