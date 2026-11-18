const connection = process.env.DATABASE_URL;

if (!connection) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

// A single configuration regardless of NODE_ENV (knex otherwise looks up config[NODE_ENV]).
module.exports = {
  client: "pg",
  connection,
  migrations: {
    directory: "./migrations",
    tableName: "knex_migrations",
  },
};
