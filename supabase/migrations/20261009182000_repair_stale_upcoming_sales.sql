begin;

set local lock_timeout = '5s';

-- A sale is "past" once its Paris civil day is over.  Nine sales still carried
-- the "upcoming" status after their day: the collector only rewrites a status
-- when it sees the sale again, and the source had already dropped them.
-- Their catalogue visibility is unaffected (it follows catalogue_expiry_deadline);
-- this only repairs the stored status.
update public.auction_sales
set status = 'past'
where status = 'upcoming'
  and sale_date is not null
  and (sale_date at time zone 'Europe/Paris')::date
      < (statement_timestamp() at time zone 'Europe/Paris')::date;

commit;
