-- Creates the migration shadow database used by `prisma migrate dev`
-- (prisma7.config.ts reads SHADOW_DATABASE_URL). This file only runs on the
-- first initialisation of the compose db volume.
CREATE DATABASE aimis_shadow;
