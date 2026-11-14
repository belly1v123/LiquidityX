/**
 * Idempotent DDL matching ./schema.ts. Applied on first DB use (Postgres or PGlite), so the app works with zero setup.
 * Bump SCHEMA_VERSION and add statements at the end for future changes (keep everything IF NOT EXISTS).
 */
export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  chain_id integer NOT NULL,
  address text NOT NULL,
  first_seen_block numeric(78,0) NOT NULL,
  first_seen_at bigint NOT NULL,
  last_active_at bigint NOT NULL,
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS lending_offers (
  chain_id integer NOT NULL,
  id numeric(78,0) NOT NULL,
  lender text NOT NULL,
  asset text NOT NULL,
  amount numeric(78,0) NOT NULL,
  remaining numeric(78,0) NOT NULL,
  apr_bps integer NOT NULL,
  max_duration integer NOT NULL,
  min_cr_bps integer NOT NULL,
  expiry bigint NOT NULL,
  created_at bigint NOT NULL,
  fills integer NOT NULL,
  status text NOT NULL,
  tx_hash text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, id)
);
CREATE INDEX IF NOT EXISTS lending_offers_lender ON lending_offers (chain_id, lender);
CREATE INDEX IF NOT EXISTS lending_offers_status ON lending_offers (chain_id, status, asset);

CREATE TABLE IF NOT EXISTS borrowing_requests (
  chain_id integer NOT NULL,
  id numeric(78,0) NOT NULL,
  borrower text NOT NULL,
  asset text NOT NULL,
  amount numeric(78,0) NOT NULL,
  filled numeric(78,0) NOT NULL,
  max_apr_bps integer NOT NULL,
  duration integer NOT NULL,
  collateral numeric(78,0) NOT NULL,
  collateral_remaining numeric(78,0) NOT NULL,
  expiry bigint NOT NULL,
  created_at bigint NOT NULL,
  fills integer NOT NULL,
  status text NOT NULL,
  tx_hash text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, id)
);
CREATE INDEX IF NOT EXISTS borrowing_requests_borrower ON borrowing_requests (chain_id, borrower);
CREATE INDEX IF NOT EXISTS borrowing_requests_status ON borrowing_requests (chain_id, status, asset);

CREATE TABLE IF NOT EXISTS loans (
  chain_id integer NOT NULL,
  id numeric(78,0) NOT NULL,
  offer_id numeric(78,0) NOT NULL,
  request_id numeric(78,0) NOT NULL,
  lender text NOT NULL,
  borrower text NOT NULL,
  asset text NOT NULL,
  principal numeric(78,0) NOT NULL,
  outstanding_principal numeric(78,0) NOT NULL,
  accrued_interest numeric(78,0) NOT NULL,
  interest_paid numeric(78,0) NOT NULL,
  principal_repaid numeric(78,0) NOT NULL,
  collateral numeric(78,0) NOT NULL,
  apr_bps integer NOT NULL,
  start bigint NOT NULL,
  maturity bigint NOT NULL,
  last_accrual bigint NOT NULL,
  closed_at bigint NOT NULL,
  status text NOT NULL,
  tx_hash text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (chain_id, id)
);
CREATE INDEX IF NOT EXISTS loans_lender ON loans (chain_id, lender);
CREATE INDEX IF NOT EXISTS loans_borrower ON loans (chain_id, borrower);

CREATE TABLE IF NOT EXISTS repayments (
  chain_id integer NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number numeric(78,0) NOT NULL,
  timestamp bigint NOT NULL,
  loan_id numeric(78,0) NOT NULL,
  payer text NOT NULL,
  interest_paid numeric(78,0) NOT NULL,
  principal_paid numeric(78,0) NOT NULL,
  outstanding_principal numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS repayments_loan ON repayments (chain_id, loan_id);

CREATE TABLE IF NOT EXISTS indexed_events (
  chain_id integer NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  timestamp bigint NOT NULL,
  contract text NOT NULL,
  address text NOT NULL,
  event_name text NOT NULL,
  kind text,
  account text,
  counterparty text,
  asset text,
  amount numeric(78,0),
  btc_amount numeric(78,0),
  offer_id numeric(78,0),
  request_id numeric(78,0),
  loan_id numeric(78,0),
  args jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS indexed_events_uniq ON indexed_events (chain_id, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS indexed_events_block ON indexed_events (chain_id, block_number);
CREATE INDEX IF NOT EXISTS indexed_events_account ON indexed_events (chain_id, account);
CREATE INDEX IF NOT EXISTS indexed_events_counterparty ON indexed_events (chain_id, counterparty);
CREATE INDEX IF NOT EXISTS indexed_events_loan ON indexed_events (chain_id, loan_id);

CREATE TABLE IF NOT EXISTS price_snapshots (
  chain_id integer NOT NULL,
  observed_at bigint NOT NULL,
  ok boolean NOT NULL,
  price numeric(78,0),
  updated_at bigint,
  PRIMARY KEY (chain_id, observed_at)
);

CREATE TABLE IF NOT EXISTS marketplace_analytics (
  chain_id integer NOT NULL,
  day text NOT NULL,
  asset text NOT NULL,
  loans_opened integer NOT NULL,
  volume numeric(78,0) NOT NULL,
  repayments integer NOT NULL,
  liquidations integer NOT NULL,
  PRIMARY KEY (chain_id, day, asset)
);

CREATE TABLE IF NOT EXISTS sync_state (
  chain_id integer PRIMARY KEY,
  last_block numeric(78,0) NOT NULL,
  last_block_hash text,
  prev_block numeric(78,0),
  prev_block_hash text,
  head_block numeric(78,0),
  last_sync_at bigint,
  last_error text,
  last_error_at bigint
);
`;
