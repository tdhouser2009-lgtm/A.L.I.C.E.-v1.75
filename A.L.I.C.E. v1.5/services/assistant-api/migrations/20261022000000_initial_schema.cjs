exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE CHECK (email = lower(email)),
      display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz
    );

    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, owner_id)
    );
    CREATE INDEX conversations_owner_updated_idx ON conversations (owner_id, updated_at DESC);

    CREATE TABLE conversation_messages (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL,
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      content text NOT NULL CHECK (length(content) <= 12000),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (conversation_id, owner_id)
        REFERENCES conversations(id, owner_id) ON DELETE CASCADE
    );
    CREATE INDEX conversation_messages_thread_created_idx
      ON conversation_messages (conversation_id, owner_id, created_at);

    CREATE TABLE enrolled_systems (
      id text NOT NULL,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL,
      health text NOT NULL CHECK (health IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
      observed_at timestamptz NOT NULL,
      connector_status text NOT NULL CHECK (connector_status IN ('connected', 'stale', 'disconnected')),
      connector_secret_name text,
      is_enrolled boolean NOT NULL DEFAULT true,
      PRIMARY KEY (id, owner_id)
    );
    CREATE INDEX enrolled_systems_owner_enrolled_name_idx
      ON enrolled_systems (owner_id, is_enrolled, name);

    CREATE TABLE diagnostic_activity (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      system_id text NOT NULL,
      diagnostic_id text NOT NULL CHECK (diagnostic_id IN ('disk-service-health', 'dependency-health', 'storage-availability')),
      status text NOT NULL CHECK (status IN ('completed', 'failed', 'timed_out')),
      redacted_output text NOT NULL,
      started_at timestamptz NOT NULL,
      completed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (system_id, owner_id)
        REFERENCES enrolled_systems(id, owner_id) ON DELETE CASCADE
    );
    CREATE INDEX diagnostic_activity_owner_created_idx ON diagnostic_activity (owner_id, created_at DESC);

    CREATE TABLE operation_proposals (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id text NOT NULL CHECK (operation_id IN ('checkpoint-retention', 'cpu-evaluation-batch', 'desktop-sync-interval')),
      summary text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
      rationale text NOT NULL,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      decision_at timestamptz,
      decision_note text,
      CHECK ((status = 'pending' AND decision_at IS NULL) OR (status <> 'pending' AND decision_at IS NOT NULL))
    );
    CREATE INDEX operation_proposals_owner_submitted_idx
      ON operation_proposals (owner_id, submitted_at DESC);
    CREATE INDEX operation_proposals_pending_expiry_idx
      ON operation_proposals (owner_id, expires_at) WHERE status = 'pending';

    CREATE TABLE audit_records (
      id uuid PRIMARY KEY,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_records_actor_created_idx ON audit_records (actor_user_id, created_at DESC);
    CREATE INDEX audit_records_entity_idx ON audit_records (entity_type, entity_id, created_at DESC);

    CREATE TABLE approved_corpora (
      id text NOT NULL,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      purpose text NOT NULL CHECK (purpose IN ('training', 'evaluation', 'both')),
      blob_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, owner_id)
    );
    CREATE INDEX approved_corpora_owner_status_purpose_idx
      ON approved_corpora (owner_id, status, purpose);

    CREATE TABLE training_runs (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      corpus_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
      checkpoint_id text,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, owner_id),
      FOREIGN KEY (corpus_id, owner_id)
        REFERENCES approved_corpora(id, owner_id) ON DELETE RESTRICT
    );
    CREATE INDEX training_runs_owner_created_idx ON training_runs (owner_id, created_at DESC);
    CREATE INDEX training_runs_pending_idx ON training_runs (status, owner_id) WHERE status IN ('queued', 'running');

    CREATE TABLE model_checkpoints (
      id text NOT NULL,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_run_id uuid NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      evaluation_status text NOT NULL DEFAULT 'not_run'
        CHECK (evaluation_status IN ('pending', 'complete', 'failed', 'not_run')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (id, owner_id),
      FOREIGN KEY (training_run_id, owner_id)
        REFERENCES training_runs(id, owner_id) ON DELETE CASCADE
    );
    CREATE INDEX model_checkpoints_owner_created_idx ON model_checkpoints (owner_id, created_at DESC);

    CREATE TABLE model_evaluations (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      checkpoint_id text NOT NULL,
      dataset_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      result jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (checkpoint_id, owner_id)
        REFERENCES model_checkpoints(id, owner_id) ON DELETE RESTRICT,
      FOREIGN KEY (dataset_id, owner_id)
        REFERENCES approved_corpora(id, owner_id) ON DELETE RESTRICT
    );
    CREATE INDEX model_evaluations_owner_created_idx ON model_evaluations (owner_id, created_at DESC);
    CREATE INDEX model_evaluations_pending_idx ON model_evaluations (status, owner_id) WHERE status IN ('queued', 'running');
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    DROP TABLE IF EXISTS model_evaluations;
    DROP TABLE IF EXISTS model_checkpoints;
    DROP TABLE IF EXISTS training_runs;
    DROP TABLE IF EXISTS approved_corpora;
    DROP TABLE IF EXISTS audit_records;
    DROP TABLE IF EXISTS operation_proposals;
    DROP TABLE IF EXISTS diagnostic_activity;
    DROP TABLE IF EXISTS enrolled_systems;
    DROP TABLE IF EXISTS conversation_messages;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS users;
  `);
};
