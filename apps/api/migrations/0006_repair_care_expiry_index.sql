-- rafay-pair:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS care_requests_pending_expiry_idx;
-- rafay-pair:next-statement
CREATE INDEX CONCURRENTLY care_requests_pending_expiry_idx
  ON care_requests(pair_id, expires_at)
  WHERE status = 'pending';
