-- rafay-pair:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS care_requests_pending_expiry_idx
  ON care_requests(pair_id, expires_at)
  WHERE status = 'pending';
