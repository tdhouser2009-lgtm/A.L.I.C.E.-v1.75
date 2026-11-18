// A.L.I.C.E. v1.5: own-model chat with continual learning, Home Assistant approvals, and opt-in sync.
exports.up = async (knex) => {
  await knex.raw(`
    -- Model versions: every checkpoint is a candidate until promoted; exactly one may be active.
    ALTER TABLE model_checkpoints ALTER COLUMN training_run_id DROP NOT NULL;
    ALTER TABLE model_checkpoints
      ADD COLUMN source text NOT NULL DEFAULT 'training'
        CHECK (source IN ('initial', 'training', 'learning', 'warm-start', 'import', 'sync')),
      ADD COLUMN status text NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('active', 'candidate', 'retired', 'rejected')),
      ADD COLUMN parent_id text,
      ADD COLUMN holdout_loss double precision,
      ADD COLUMN parameters integer,
      ADD COLUMN promoted_at timestamptz,
      ADD COLUMN note text NOT NULL DEFAULT '';
    CREATE UNIQUE INDEX model_checkpoints_one_active_idx ON model_checkpoints (owner_id) WHERE status = 'active';

    ALTER TABLE training_runs
      ADD COLUMN kind text NOT NULL DEFAULT 'training' CHECK (kind IN ('training', 'learning', 'warm-start')),
      ADD COLUMN base_checkpoint_id text,
      ADD COLUMN candidate_checkpoint_id text,
      ADD COLUMN holdout_dataset_id text,
      ADD COLUMN evaluation_id uuid,
      ADD COLUMN max_steps integer NOT NULL DEFAULT 0,
      ADD COLUMN loss double precision,
      ADD COLUMN decision text CHECK (decision IN ('promoted', 'kept-for-review', 'not-better')),
      ADD COLUMN stats jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN error text;

    ALTER TABLE model_evaluations ADD COLUMN baseline_checkpoint_id text;

    ALTER TABLE approved_corpora
      ADD COLUMN bytes integer NOT NULL DEFAULT 0,
      ADD COLUMN source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'learning', 'warm-start'));

    CREATE TABLE model_settings (
      owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_backend text NOT NULL DEFAULT 'local' CHECK (chat_backend IN ('local', 'ollama')),
      learning_enabled boolean NOT NULL DEFAULT false,
      auto_promote boolean NOT NULL DEFAULT true,
      learn_every_turns integer NOT NULL DEFAULT 8 CHECK (learn_every_turns BETWEEN 1 AND 1000),
      learning_steps integer NOT NULL DEFAULT 150 CHECK (learning_steps BETWEEN 1 AND 5000),
      sync_share_enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Chat turns remember whether the user allowed learning when they were written.
    ALTER TABLE conversation_messages
      ADD COLUMN learning_consent boolean NOT NULL DEFAULT false,
      ADD COLUMN learned_in_run uuid,
      ADD COLUMN backend text,
      ADD COLUMN model text;
    CREATE INDEX conversation_messages_learning_idx
      ON conversation_messages (owner_id, created_at) WHERE learning_consent AND learned_in_run IS NULL;

    CREATE TABLE model_feedback (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL,
      message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      rating text NOT NULL CHECK (rating IN ('up', 'down')),
      correction text CHECK (correction IS NULL OR length(correction) <= 12000),
      use_for_training boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, message_id)
    );

    -- Approval queue: Home Assistant actions run only after approval (or for auto-approved domains).
    ALTER TABLE operation_proposals DROP CONSTRAINT IF EXISTS operation_proposals_operation_id_check;
    ALTER TABLE operation_proposals
      ADD CONSTRAINT operation_proposals_operation_id_check CHECK (operation_id IN (
        'checkpoint-retention', 'cpu-evaluation-batch', 'desktop-sync-interval', 'home-assistant-action')),
      ADD COLUMN target jsonb,
      ADD COLUMN executed_at timestamptz,
      ADD COLUMN execution_status text CHECK (execution_status IN ('succeeded', 'failed')),
      ADD COLUMN execution_result jsonb;

    -- Opt-in sync hub: consented turns uploaded by other installs.
    CREATE TABLE sync_contributions (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      install_id text NOT NULL,
      user_text text NOT NULL CHECK (length(user_text) <= 12000),
      assistant_text text NOT NULL CHECK (length(assistant_text) <= 12000),
      learned_in_run uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sync_contributions_pending_idx ON sync_contributions (owner_id, created_at) WHERE learned_in_run IS NULL;
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    DROP TABLE IF EXISTS sync_contributions;
    DELETE FROM operation_proposals WHERE operation_id = 'home-assistant-action';
    ALTER TABLE operation_proposals DROP CONSTRAINT IF EXISTS operation_proposals_operation_id_check;
    ALTER TABLE operation_proposals
      DROP COLUMN IF EXISTS target, DROP COLUMN IF EXISTS executed_at,
      DROP COLUMN IF EXISTS execution_status, DROP COLUMN IF EXISTS execution_result,
      ADD CONSTRAINT operation_proposals_operation_id_check CHECK (operation_id IN ('checkpoint-retention', 'cpu-evaluation-batch', 'desktop-sync-interval'));
    DROP TABLE IF EXISTS model_feedback;
    DROP INDEX IF EXISTS conversation_messages_learning_idx;
    ALTER TABLE conversation_messages
      DROP COLUMN IF EXISTS learning_consent, DROP COLUMN IF EXISTS learned_in_run,
      DROP COLUMN IF EXISTS backend, DROP COLUMN IF EXISTS model;
    DROP TABLE IF EXISTS model_settings;
    ALTER TABLE approved_corpora DROP COLUMN IF EXISTS bytes, DROP COLUMN IF EXISTS source;
    ALTER TABLE model_evaluations DROP COLUMN IF EXISTS baseline_checkpoint_id;
    ALTER TABLE training_runs
      DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS base_checkpoint_id, DROP COLUMN IF EXISTS candidate_checkpoint_id,
      DROP COLUMN IF EXISTS holdout_dataset_id, DROP COLUMN IF EXISTS evaluation_id, DROP COLUMN IF EXISTS max_steps,
      DROP COLUMN IF EXISTS loss, DROP COLUMN IF EXISTS decision, DROP COLUMN IF EXISTS stats, DROP COLUMN IF EXISTS error;
    DROP INDEX IF EXISTS model_checkpoints_one_active_idx;
    DELETE FROM model_checkpoints WHERE training_run_id IS NULL;
    ALTER TABLE model_checkpoints
      DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS parent_id,
      DROP COLUMN IF EXISTS holdout_loss, DROP COLUMN IF EXISTS parameters, DROP COLUMN IF EXISTS promoted_at, DROP COLUMN IF EXISTS note;
    ALTER TABLE model_checkpoints ALTER COLUMN training_run_id SET NOT NULL;
  `);
};
