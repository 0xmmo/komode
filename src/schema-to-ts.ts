/**
 * Generate TypeScript declarations from tool JSON schemas. The output is
 * shown to the model, documenting the functions available inside
 * execute_code. This is the heart of code mode: models write far better
 * TypeScript against a typed API than they chain JSON tool calls.
 */

/** A JSON Schema subset: what tool parameters and returns are described with. */
export interface JsonSchema {
  // A single type name, or an array like ["string", "null"] for a nullable value
  type?: string | string[];
  description?: string;
  enum?: Array<string | number>;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  // OpenAPI-style nullability (equivalent to including "null" in `type`)
  nullable?: boolean;
  [key: string]: unknown;
}

/** A function as the model sees it: name, docs, and JSON-schema input/output. */
export interface FunctionSchema {
  name: string;
  description?: string;
  /** JSON Schema for the single object argument */
  parameters?: JsonSchema;
  /** Optional JSON Schema for the resolved value; without it the function returns a string */
  returns?: JsonSchema;
}

/** Map a single JSON Schema type name to its TypeScript type. */
function baseTypeForName(
  typeName: string | undefined,
  schema: JsonSchema,
  indentLevel: number,
): string {
  switch (typeName) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const itemType = schema.items
        ? schemaToType(schema.items, indentLevel)
        : "unknown";
      // Parenthesize unions so e.g. ("a" | "b")[] parses as intended
      const isObjectLiteral = itemType.startsWith("{") && itemType.endsWith("}");
      return itemType.includes("|") && !isObjectLiteral ? `(${itemType})[]` : `${itemType}[]`;
    }
    case "object":
      return objectType(schema, indentLevel);
    default:
      return "unknown";
  }
}

function schemaToType(schema: JsonSchema, indentLevel: number): string {
  // `type` may be a single name or an array (["string", "null"]); a value is
  // nullable when "null" is in that array or `nullable: true` is set. Render
  // the non-null base type, then append `| null` so the model's generated TS
  // matches values that can actually come back null at runtime.
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  const nullable = schema.nullable === true || types.includes("null");
  const nonNull = types.filter((t) => t !== "null");

  let base: string;
  if (schema.enum?.length) {
    base = schema.enum
      .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
      .join(" | ");
  } else if (nonNull.length > 1) {
    base = nonNull.map((t) => baseTypeForName(t, schema, indentLevel)).join(" | ");
  } else {
    base = baseTypeForName(nonNull[0], schema, indentLevel);
  }

  return nullable ? `${base} | null` : base;
}

function objectType(schema: JsonSchema, indentLevel: number): string {
  const properties = schema.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return "Record<string, unknown>";
  }

  const indent = "  ".repeat(indentLevel + 1);
  const closeIndent = "  ".repeat(indentLevel);
  const required = new Set(schema.required ?? []);

  const lines: string[] = [];
  for (const [key, propSchema] of Object.entries(properties)) {
    if (propSchema.description) {
      lines.push(`${indent}/** ${propSchema.description.replace(/\n/g, " ").trim()} */`);
    }
    const optional = required.has(key) ? "" : "?";
    // Keys from foreign schemas (MCP servers) can be non-identifiers ("x-id")
    const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    lines.push(
      `${indent}${safeKey}${optional}: ${schemaToType(propSchema, indentLevel + 1)};`,
    );
  }
  return `{\n${lines.join("\n")}\n${closeIndent}}`;
}

/**
 * Render one tool schema as a typed async function declaration with JSDoc.
 * All bindings resolve to a string result and throw Error on failure.
 */
export function functionSchemaToTs(schema: FunctionSchema): string {
  // Error semantics (throw on failure) are documented once in the code-mode
  // instructions, not repeated per function.
  const docLines: string[] = ["/**"];
  const description = (schema.description || "").trim();
  for (const line of description.split("\n")) {
    docLines.push(` * ${line.trim()}`);
  }
  docLines.push(" */");

  const params = schema.parameters as JsonSchema | undefined;
  const hasParams =
    params?.properties && Object.keys(params.properties).length > 0;
  const inputType = hasParams ? objectType(params as JsonSchema, 0) : "";

  // Tools that declare a `returns` schema get a typed Promise; the rest keep
  // a string result.
  const returns = schema.returns;
  const returnType = returns ? schemaToType(returns, 0) : "string";

  const signature = hasParams
    ? `declare function ${schema.name}(input: ${inputType}): Promise<${returnType}>;`
    : `declare function ${schema.name}(): Promise<${returnType}>;`;

  return `${docLines.join("\n")}\n${signature}`;
}

/** Render the full API surface for a set of function schemas. */
export function buildToolsApi(schemas: FunctionSchema[]): string {
  return schemas.map(functionSchemaToTs).join("\n\n");
}
