import { describe, it, expect } from "vitest";
import { buildToolsApi, functionSchemaToTs } from "../src/schema-to-ts";

describe("schema-to-ts", () => {
  it("renders a typed async declaration with JSDoc", () => {
    const ts = functionSchemaToTs({
      name: "getWeather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          units: { type: "string", enum: ["c", "f"] },
          days: { type: "integer" },
        },
        required: ["city"],
      },
    });
    expect(ts).toContain("/**\n * Current weather for a city.\n */");
    expect(ts).toContain("declare function getWeather(input: {");
    expect(ts).toContain("/** City name */");
    expect(ts).toContain("city: string;");
    expect(ts).toContain('units?: "c" | "f";');
    expect(ts).toContain("days?: number;");
    expect(ts).toContain("}): Promise<string>;");
  });

  it("types the result from a returns schema, including nullable and arrays of unions", () => {
    const ts = functionSchemaToTs({
      name: "search",
      description: "Search.",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      returns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            score: { type: ["number", "null"] },
            kind: { type: "string", enum: ["a", "b"] },
          },
          required: ["title"],
        },
      },
    });
    expect(ts).toContain("score?: number | null;");
    expect(ts).toContain('kind?: "a" | "b";');
    expect(ts).toMatch(/Promise<\{[\s\S]*\}\[\]>;$/);
  });

  it("renders no-arg functions and quotes non-identifier keys", () => {
    expect(functionSchemaToTs({ name: "now", description: "Time." })).toContain("declare function now(): Promise<string>;");
    const ts = functionSchemaToTs({
      name: "get",
      parameters: { type: "object", properties: { "x-id": { type: "string" } } },
    });
    expect(ts).toContain('"x-id"?: string;');
  });

  it("joins multiple declarations", () => {
    const api = buildToolsApi([
      { name: "a", description: "A." },
      { name: "b", description: "B." },
    ]);
    expect(api.split("declare function").length - 1).toBe(2);
  });
});
