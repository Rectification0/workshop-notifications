CREATE TABLE IF NOT EXISTS workshops (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  organizer_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id   UUID NOT NULL REFERENCES workshops(id),
  member_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_registration_member UNIQUE (workshop_id, member_id)      -- FR-3
);

CREATE TABLE IF NOT EXISTS notifications (                               -- the outbox
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),           -- = Idempotency-Key (FR-10)
  type             TEXT NOT NULL CHECK (type IN ('registration_confirmation','workshop_cancelled')),
  registration_id  UUID NOT NULL REFERENCES registrations(id),
  workshop_id      UUID NOT NULL REFERENCES workshops(id),
  member_id        TEXT NOT NULL,
  email            TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  attempts         INT  NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  CONSTRAINT uq_notification_per_registration UNIQUE (registration_id, type)  -- never enqueue twice
);

CREATE INDEX IF NOT EXISTS idx_notifications_due
  ON notifications (next_attempt_at) WHERE status = 'pending';
