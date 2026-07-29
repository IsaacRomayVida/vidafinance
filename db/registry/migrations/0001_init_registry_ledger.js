exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Canonical identity registry: every business-critical real-world thing
    -- exists exactly once under one durable UUID.
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      display_name text,
      attrs jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Every external system ID is a pointer to one entity, never a
    -- competing copy of it.
    CREATE TABLE entity_refs (
      system text NOT NULL,
      external_id text NOT NULL,
      entity_id uuid NOT NULL REFERENCES entities(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (system, external_id)
    );
    CREATE INDEX entity_refs_entity_idx ON entity_refs(entity_id);

    -- N-ary, reified relationships: a multi-party fact is one addressable
    -- record linking all participants with roles.
    CREATE TABLE relationships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      attrs jsonb NOT NULL DEFAULT '{}',
      valid_from timestamptz NOT NULL DEFAULT now(),
      valid_to timestamptz
    );

    CREATE TABLE relationship_members (
      relationship_id uuid NOT NULL REFERENCES relationships(id),
      entity_id uuid NOT NULL REFERENCES entities(id),
      role text NOT NULL,
      PRIMARY KEY (relationship_id, entity_id, role)
    );

    -- Append-only, hash-chained receipts. Every consequential action writes
    -- exactly one receipt; idempotency_key IS the receipt identity.
    -- The hash chain itself is computed application-side by a single
    -- writer path (see src/hashChain.js) -- this table only stores it and
    -- refuses to let anyone mutate history after the fact.
    CREATE TABLE receipts (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      ts timestamptz NOT NULL DEFAULT now(),
      actor_entity_id uuid NOT NULL REFERENCES entities(id),
      action text NOT NULL,
      target_entity_id uuid REFERENCES entities(id),
      relationship_id uuid REFERENCES relationships(id),
      evidence jsonb NOT NULL DEFAULT '{}',
      idempotency_key text UNIQUE,
      prev_hash bytea NOT NULL,
      hash bytea NOT NULL
    );

    CREATE FUNCTION receipts_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'receipts is append-only: % on receipts is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER receipts_no_update_delete
      BEFORE UPDATE OR DELETE ON receipts
      FOR EACH ROW EXECUTE FUNCTION receipts_immutable();

    -- Authority rules for the authorize() gate. DDL only in this phase --
    -- no rows are enabled and no code calls authorize() yet (Phase D).
    CREATE TABLE authority_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_kind text NOT NULL,
      action text NOT NULL,
      constraint_expr jsonb NOT NULL DEFAULT '{}',
      enabled boolean NOT NULL DEFAULT true
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS authority_rules;
    DROP TRIGGER IF EXISTS receipts_no_update_delete ON receipts;
    DROP FUNCTION IF EXISTS receipts_immutable();
    DROP TABLE IF EXISTS receipts;
    DROP TABLE IF EXISTS relationship_members;
    DROP TABLE IF EXISTS relationships;
    DROP TABLE IF EXISTS entity_refs;
    DROP TABLE IF EXISTS entities;
  `);
};
