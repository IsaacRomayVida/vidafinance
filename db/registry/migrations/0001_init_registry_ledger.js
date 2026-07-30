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
    CREATE INDEX relationship_members_entity_idx ON relationship_members(entity_id);

    -- Append-only, hash-chained receipts. Every consequential action writes
    -- exactly one receipt; idempotency_key IS the receipt identity.
    -- The hash chain itself is computed application-side by a single
    -- writer path (see services/shared/registry/hashChain.js) -- this table
    -- only stores it and refuses to let anyone mutate history after the fact.
    --
    -- hash_version records which canonicalization/hash algorithm produced
    -- this row's hash (see hashChain.js HASH_VERSIONS map) so the algorithm
    -- can evolve later without invalidating rows written under an earlier
    -- version. It is NOT itself part of the hashed payload -- it is the
    -- dispatch key verifyChain uses to pick the right algorithm per row.
    CREATE TABLE receipts (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      ts timestamptz NOT NULL DEFAULT now(),
      actor_entity_id uuid NOT NULL REFERENCES entities(id),
      action text NOT NULL,
      target_entity_id uuid REFERENCES entities(id),
      relationship_id uuid REFERENCES relationships(id),
      evidence jsonb NOT NULL DEFAULT '{}',
      idempotency_key text UNIQUE,
      hash_version smallint NOT NULL DEFAULT 1,
      prev_hash bytea NOT NULL,
      hash bytea NOT NULL,
      CONSTRAINT receipts_prev_hash_unique UNIQUE (prev_hash)
    );

    CREATE FUNCTION receipts_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'receipts is append-only: % on receipts is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER receipts_no_update_delete
      BEFORE UPDATE OR DELETE ON receipts
      FOR EACH ROW EXECUTE FUNCTION receipts_immutable();

    -- TRUNCATE fires no row-level triggers, so the guard above does not
    -- cover it on its own: a single TRUNCATE statement would otherwise wipe
    -- the entire ledger. This is a statement-level trigger so it catches
    -- that case too, for every role -- including the table owner.
    CREATE TRIGGER receipts_no_truncate
      BEFORE TRUNCATE ON receipts
      FOR EACH STATEMENT EXECUTE FUNCTION receipts_immutable();

    -- Authority rules for the authorize() gate. DDL only in this phase --
    -- no rows are enabled and no code calls authorize() yet (Phase D).
    CREATE TABLE authority_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_kind text NOT NULL,
      action text NOT NULL,
      constraint_expr jsonb NOT NULL DEFAULT '{}',
      enabled boolean NOT NULL DEFAULT true
    );

    -- Least-privilege boundary for the application: registry_app may never
    -- hold UPDATE/DELETE/TRUNCATE on receipts, so the append-only guarantee
    -- holds even if a future bug tries to violate it in application code
    -- (defense in depth alongside the triggers above, not instead of them).
    -- Migration-time known name: every future migration touching grants
    -- must reference this same role.
    --
    -- The role is created here WITHOUT login capability -- provisioning its
    -- password and switching REGISTRY_DATABASE_URL to connect as
    -- registry_app instead of the database owner is a deliberate follow-up
    -- operational step (ALTER ROLE registry_app LOGIN PASSWORD '<generated>'
    -- run out-of-band by whoever administers the Railway instance), not
    -- something a committed migration should ever do with a hardcoded or
    -- generated-in-CI secret.
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'registry_app') THEN
        CREATE ROLE registry_app NOLOGIN;
      END IF;
    END
    $$;

    GRANT USAGE ON SCHEMA public TO registry_app;
    GRANT SELECT, INSERT, UPDATE ON entities, entity_refs, relationships, relationship_members, authority_rules TO registry_app;
    GRANT SELECT, INSERT ON receipts TO registry_app;

    REVOKE UPDATE, DELETE, TRUNCATE ON receipts FROM PUBLIC;
    REVOKE UPDATE, DELETE, TRUNCATE ON receipts FROM registry_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    REVOKE ALL ON entities, entity_refs, relationships, relationship_members, receipts, authority_rules FROM registry_app;
    REVOKE USAGE ON SCHEMA public FROM registry_app;

    DO $$
    BEGIN
      DROP ROLE IF EXISTS registry_app;
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE NOTICE 'registry_app still referenced by other databases in this cluster; leaving role in place';
    END
    $$;

    DROP TABLE IF EXISTS authority_rules;
    DROP TRIGGER IF EXISTS receipts_no_truncate ON receipts;
    DROP TRIGGER IF EXISTS receipts_no_update_delete ON receipts;
    DROP FUNCTION IF EXISTS receipts_immutable();
    DROP TABLE IF EXISTS receipts;
    DROP INDEX IF EXISTS relationship_members_entity_idx;
    DROP TABLE IF EXISTS relationship_members;
    DROP TABLE IF EXISTS relationships;
    DROP TABLE IF EXISTS entity_refs;
    DROP TABLE IF EXISTS entities;
  `);
};
