#!/usr/bin/env node
// Makes the secrets for deploy/.env: a database password, a JWT secret, and the
// anon and service_role keys signed with it (HS256, 10 years), the same shapes
// the Supabase self-hosting guide uses. Prints them once; nothing is stored.
// Usage: node deploy/generate-keys.mjs
import { createHmac, randomBytes } from "node:crypto";

const base64url = (input) => Buffer.from(input).toString("base64url");

function signJwt(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);
const tenYears = 10 * 365 * 24 * 60 * 60;
const jwtSecret = randomBytes(32).toString("base64url");
const postgresPassword = randomBytes(24).toString("hex");
const claims = (role) => ({ role, iss: "supabase", iat: now, exp: now + tenYears });

console.log("# Paste these into deploy/.env (keep the file private)");
console.log(`POSTGRES_PASSWORD=${postgresPassword}`);
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`ANON_KEY=${signJwt(claims("anon"), jwtSecret)}`);
console.log(`SERVICE_ROLE_KEY=${signJwt(claims("service_role"), jwtSecret)}`);
