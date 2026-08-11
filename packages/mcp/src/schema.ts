import Type, { type TSchema } from "typebox";

/**
 * Convert MCP JSON-Schema input schemas into Pi TypeBox parameter schemas.
 *
 * Pi tool parameters must be a TypeBox `TSchema` (an object). MCP tool inputs
 * are JSON Schema documents. We translate the common, well-specified subset
 * (object/string/number/integer/boolean/array, properties, required,
 * description, enum, items, nested objects) and fall back to permissive types
 * for anything exotic so a tool always remains callable and introspectable.
 */

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
};

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "";
}

function convertType(schema: unknown): TSchema {
  if (!isRecord(schema)) return Type.Any();
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const annotate = <T extends TSchema>(t: T): T => {
    if (description) Object.assign(t, { description });
    return t;
  };

  switch (typeName(schema)) {
    case "string": {
      if (Array.isArray(schema.enum)) {
        return annotate(Type.Union(schema.enum.map((value) => Type.Literal(value as string | number | boolean))));
      }
      return annotate(Type.String());
    }
    case "number":
      return annotate(Type.Number());
    case "integer":
      return annotate(Type.Integer());
    case "boolean":
      return annotate(Type.Boolean());
    case "array":
      return annotate(Type.Array(convertType(schema.items)));
    case "object": {
      const properties: Record<string, TSchema> = {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        const converted = convertType(value);
        properties[key] = required.has(key) ? converted : Type.Optional(converted);
      }
      return annotate(Type.Object(properties));
    }
    default:
      return annotate(Type.Any());
  }
}

/** Convert an MCP tool input schema into a TypeBox schema (may be non-object). */
export function toTypeBoxSchema(inputSchema?: unknown): TSchema {
  if (isRecord(inputSchema) && typeName(inputSchema) === "object") {
    return convertType(inputSchema);
  }
  // Non-object or missing schemas are wrapped so the tool still takes an object.
  return Type.Object({ value: convertType(inputSchema) });
}

/** Always produce an object parameter schema for a Pi tool registration. */
export function objectSchemaFromMcp(inputSchema?: unknown): TSchema {
  const converted = toTypeBoxSchema(inputSchema);
  if (isRecord(inputSchema) && typeName(inputSchema) === "object") return converted;
  return converted;
}