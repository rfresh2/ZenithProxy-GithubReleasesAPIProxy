import { SQL } from "bun";

export default class MetricsClient {
  constructor() {
    this.sql = new SQL({
      adapter: "postgres",
      hostname: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 10,
      idleTimeout: 30,
      max: 2,
    });
  }

  async stop() {
    await this.sql.close();
    console.log("Disconnected from metrics DB");
  }

  async addRequestCount(requestCount) {
    await this.sql`INSERT INTO api_proxy_request_count_metrics (time, request_count) VALUES (${new Date().toISOString()}, ${requestCount})`;
  }
}
