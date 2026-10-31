import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.string().default("info"),
  API_KEY: z.string().min(16).optional().or(z.literal("").transform(() => undefined)),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().positive().default(24),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  console.error("Invalid environment configuration:\n - " + problems.join("\n - "));
  process.exit(1);
}

export const config = parsed.data;

if (config.NODE_ENV === "production" && !config.API_KEY) {
  console.error("API_KEY is required when NODE_ENV=production");
  process.exit(1);
}
