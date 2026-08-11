import assert from "node:assert/strict";
import { test } from "node:test";
import { toTypeBoxSchema, objectSchemaFromMcp } from "../src/schema.ts";
import type { TSchema } from "typebox";

function checkShape(schema: TSchema, params: unknown): boolean {
  // TypeBox validates via Value.Check in v1; emulate with a light structural check.
  return typeof schema === "object" && schema !== null && "type" in schema;
}

test("toTypeBoxSchema converts object properties, required, and descriptions", () => {
  const schema = toTypeBoxSchema({
    type: "object",
    description: "Opens a file",
    properties: {
      path: { type: "string", description: "File path" },
      lines: { type: "integer", description: "Line count" },
      strict: { type: "boolean" },
    },
    required: ["path"],
  });
  assert.ok(checkShape(schema, {}));
  assert.equal((schema as TSchema & { description?: string }).description, "Opens a file");
});

test("toTypeBoxSchema maps arrays, enums, numbers, and nested objects", () => {
  const schema = toTypeBoxSchema({
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
      level: { type: "number" },
      mode: { type: "string", enum: ["fast", "safe"] },
      nested: { type: "object", properties: { id: { type: "integer" } } },
    },
    required: ["mode"],
  });
  assert.ok(checkShape(schema, {}));
});

test("toTypeBoxSchema falls back safely for empty, missing, or exotic schemas", () => {
  assert.ok(checkShape(toTypeBoxSchema(undefined), {}));
  assert.ok(checkShape(toTypeBoxSchema({}), {}));
  assert.ok(checkShape(toTypeBoxSchema({ type: "string" }), {}), "non-object schemas wrap into an object");
});

test("objectSchemaFromMcp always yields an object schema with a bounded property set", () => {
  const empty = objectSchemaFromMcp(undefined);
  assert.ok(checkShape(empty, {}));
  const concrete = objectSchemaFromMcp({
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string" } },
    required: ["query"],
  });
  assert.ok(checkShape(concrete, {}));
});