import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedDemo } from '../src/lib/demo-seed';
const db = new PrismaClient();
/**
 * Demo seed (logic in src/lib/demo-seed.ts, shared with Settings → "Reset demo to today").
 * DEMO_RESEED=true wipes the demo tables and reseeds them in one transaction; otherwise existing rows
 * are kept. DEMO_NOW fixes "now"; DEMO_FIXED_DATES=true keeps the old fixed October dates.
 */
const reseed = process.env.DEMO_RESEED === 'true';
const run = (tx: Parameters<typeof seedDemo>[0]) =>
  seedDemo(tx, { reseed, fixedDates: process.env.DEMO_FIXED_DATES === 'true', log: (l) => console.log(l) });
(reseed ? db.$transaction(run, { timeout: 300000, maxWait: 30000 }) : run(db))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
