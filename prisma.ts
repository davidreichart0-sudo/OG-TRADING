import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the whole process — avoids exhausting the
// Postgres connection pool by creating a new client per module.
export const prisma = new PrismaClient();

export async function disconnectPrisma() {
  await prisma.$disconnect();
}
