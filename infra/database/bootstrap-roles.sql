\set ON_ERROR_STOP on

-- Run once with the RDS-managed administrator URL. Passwords are prompted
-- without terminal echo and are never written to this repository or Terraform.
\if :{?migration_password}
\else
\prompt -s 'Migration role password: ' migration_password
\endif
\if :{?runtime_password}
\else
\prompt -s 'Runtime login password: ' runtime_password
\endif

SELECT format(
  'CREATE ROLE rafay_pair_migration LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'migration_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rafay_pair_migration')
\gexec

SELECT format(
  'ALTER ROLE rafay_pair_migration PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'migration_password'
)
\gexec

SELECT 'CREATE ROLE rafay_pair_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rafay_pair_runtime')
\gexec

SELECT format(
  'CREATE ROLE rafay_pair_runtime_login LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'runtime_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rafay_pair_runtime_login')
\gexec

SELECT format(
  'ALTER ROLE rafay_pair_runtime_login PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'runtime_password'
)
\gexec

GRANT rafay_pair_runtime TO rafay_pair_runtime_login;
REVOKE CONNECT ON DATABASE rafay_pair FROM PUBLIC;
GRANT CONNECT ON DATABASE rafay_pair TO rafay_pair_migration, rafay_pair_runtime;
ALTER DATABASE rafay_pair OWNER TO rafay_pair_migration;

\connect rafay_pair

ALTER SCHEMA public OWNER TO rafay_pair_migration;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rafay_pair_runtime;
