-- Phase 0 baseline migration. Establishes the multi-tenant primitives
-- (a tenants table) that domain-module migrations will FK against.
--
-- The Spring Modulith event_publication table is currently auto-created by
-- spring-modulith-starter-jpa (per application.yml's
-- spring.modulith.events.jdbc.schema-initialization.enabled=true). At Phase 1+,
-- migrate that schema into a Flyway migration here so core fully owns it
-- (per prd-core-module.md F16).

CREATE TABLE IF NOT EXISTS tenants (
    org_id      TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed a development tenant so dev-mode TenantContext (which defaults to org_id='dev-org')
-- has a referent. Replace with org provisioning at Phase 7 (auth lands).
INSERT INTO tenants (org_id, display_name)
VALUES ('dev-org', 'Local Development Org')
ON CONFLICT (org_id) DO NOTHING;
