CREATE TABLE IF NOT EXISTS transactions (
  tx_id text PRIMARY KEY,
  client_request_id text UNIQUE,
  from_account text NOT NULL,
  to_account text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (
    status IN ('INITIATED', 'PREPARING', 'PREPARED', 'COMMIT_DECIDED', 'ABORT_DECIDED', 'COMPLETED')
  ),
  outcome text CHECK (outcome IN ('COMMITTED', 'ABORTED')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  completed_at timestamptz,
  CHECK ((status = 'COMPLETED') = (outcome IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS participants (
  tx_id text NOT NULL REFERENCES transactions(tx_id) ON DELETE CASCADE,
  shard_id text NOT NULL,
  gid text NOT NULL,
  vote text NOT NULL DEFAULT 'PENDING' CHECK (vote IN ('PENDING', 'YES', 'NO')),
  vote_reason text,
  ack text NOT NULL DEFAULT 'PENDING' CHECK (ack IN ('PENDING', 'DONE')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_id, shard_id)
);

CREATE TABLE IF NOT EXISTS tx_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx_id text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_unresolved_idx
  ON transactions (created_at)
  WHERE status <> 'COMPLETED';

CREATE INDEX IF NOT EXISTS tx_events_tx_idx ON tx_events (tx_id, id);
