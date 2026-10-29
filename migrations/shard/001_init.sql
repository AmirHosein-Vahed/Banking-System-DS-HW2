CREATE TABLE IF NOT EXISTS accounts (
  account_id text PRIMARY KEY CHECK (account_id ~ '^A[0-9]{4}$'),
  balance bigint NOT NULL CHECK (balance >= 0),
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx_id text NOT NULL,
  account_id text NOT NULL REFERENCES accounts(account_id),
  delta bigint NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('deposit', 'withdraw', 'transfer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX IF NOT EXISTS ledger_entries_tx_idx ON ledger_entries (tx_id);

CREATE TABLE IF NOT EXISTS client_requests (
  request_id text PRIMARY KEY,
  payload_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participant_txs (
  tx_id text PRIMARY KEY,
  gid text NOT NULL UNIQUE,
  shard_id text NOT NULL,
  ops jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PREPARING', 'PREPARED', 'COMMITTED', 'ABORTED')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS participant_txs_state_idx ON participant_txs (state);
