import { describe, it, expect } from "vitest";
import { Agent, AbortedError, type AgentOptions, BaseContext, BaseTool, defineContext, defineSkill, defineTool, toolResult } from "../src/index";
import { code, lastToolResult, scriptedModel, text, useSkills } from "./helpers";

const getWeather = defineTool<{ city: string }>({
  name: "getWeather",
  description: "Current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  run: async ({ city }) => `Sunny in ${city}, 31°C`,
});

const weatherSkill = defineSkill({
  name: "weather",
  description: "Weather lookups",
  instructions: "Use getWeather for current conditions.",
  tools: [getWeather],
});

const agentWith = <S = any>(model: ReturnType<typeof scriptedModel>, opts: Partial<AgentOptions<S>> = {}) =>
  new Agent<S>({ model: "test:model", callModel: (req) => model.callModel(req), sandbox: { fetch: false }, ...opts });

describe("Agent", () => {
  it("answers plain conversation without tools", async () => {
    const model = scriptedModel([text("Hello!")]);
    const result = await agentWith(model).run("hi");
    expect(result.text).toBe("Hello!");
    expect(result.stopReason).toBe("reply");
    expect(result.usage.modelCalls).toBe(1);
    // Without skills, only execute_code is offered
    expect(model.requests[0].functions?.map((f) => f.name)).toEqual(["execute_code"]);
  });

  it("builds a system prompt with instructions, skill catalog and contexts", async () => {
    const model = scriptedModel([text("ok")]);
    await agentWith(model, {
      instructions: "You are Weatherbot.",
      skills: [weatherSkill],
      contexts: [defineContext({ tag: "user_city", build: (s: { city: string }) => `Lives in ${s.city} <b>` })],
    }).run("hi", { state: { city: "Cairo" } });
    const system = model.requests[0].messages[0].content;
    expect(system).toContain("<system_instructions>\n  You are Weatherbot.");
    expect(system).toContain("`weather` - Weather lookups");
    expect(system).toContain("<user_city>\n  Lives in Cairo &lt;b&gt;\n</user_city>");
    // Skill tools are NOT declared until the skill loads
    expect(system).not.toContain("declare function getWeather");
    expect(model.requests[0].functions?.map((f) => f.name)).toEqual(["use_skills", "execute_code"]);
  });

  it("loads a skill, runs code against its tool, and replies", async () => {
    const model = scriptedModel([
      useSkills("weather"),
      (req) => {
        const loaded = lastToolResult(req);
        expect(loaded).toContain("<instructions>");
        expect(loaded).toContain("declare function getWeather(input: {");
        return code(`const w = await getWeather({ city: "Cairo" });\nreturn w;`, { content: "Checking…" });
      },
      (req) => {
        const out = lastToolResult(req);
        expect(out).toContain("<completed_calls>");
        expect(out).toContain('getWeather({"city":"Cairo"}) -> ok');
        expect(out).toContain("Sunny in Cairo, 31°C");
        return text("It's sunny in Cairo.");
      },
    ]);
    const events: string[] = [];
    const result = await agentWith(model, { skills: [weatherSkill] }).run("Weather in Cairo?", {
      onEvent: (e) => events.push(e.type),
    });
    expect(result.text).toBe("It's sunny in Cairo.");
    expect(result.skillsLoaded).toEqual(["weather"]);
    expect(result.steps.map((s) => s.type)).toEqual(["use_skills", "execute_code"]);
    expect(result.usage.executeCalls).toBe(1);
    expect(events).toContain("narration");
    expect(events).toContain("skills_loaded");
    expect(events).toContain("tool_call");
  });

  it("hints the owning skill when code calls an unloaded skill's tool", async () => {
    const model = scriptedModel([
      code(`return await getWeather({ city: "Paris" });`),
      (req) => {
        const out = lastToolResult(req);
        expect(out).toMatch(/'getWeather' is not defined/);
        expect(out).toContain('provided by the "weather" skill');
        expect(out).toContain('use_skills(["weather"])');
        return text("done");
      },
    ]);
    await agentWith(model, { skills: [weatherSkill] }).run("weather?");
    expect(model.calls).toBe(2);
  });

  it("passes caller state to class and function tools, and to state-aware instructions", async () => {
    class Greet extends BaseTool<{ user: string }> {
      static schema = { name: "greet", description: "Greets the user." };
      execute() {
        return `hi ${this.state.user}`;
      }
    }
    const model = scriptedModel([code(`return await greet();`), (req) => text(lastToolResult(req).includes("hi Mo") ? "ok" : "bad")]);
    const result = await agentWith(model, {
      tools: [Greet],
      instructions: (s: { user: string }) => `Talking to ${s.user}`,
    }).run("hey", { state: { user: "Mo" } });
    expect(result.text).toBe("ok");
    expect(model.requests[0].messages[0].content).toContain("Talking to Mo");
    expect(model.requests[0].messages[0].content).toContain("declare function greet(): Promise<string>;");
  });

  it("collects files from tools and returns them with the reply", async () => {
    const makeReport = defineTool({
      name: "makeReport",
      description: "Makes a PDF.",
      run: () => toolResult({ files: [{ fileName: "r.pdf", mimeType: "application/pdf", url: "https://x/r.pdf" }] }),
    });
    const model = scriptedModel([
      code(`return await makeReport();`),
      (req) => {
        expect(lastToolResult(req)).toContain("File(s) produced: r.pdf");
        return text("Here you go.");
      },
    ]);
    const result = await agentWith(model, { tools: [makeReport] }).run("report");
    expect(result.files).toEqual([{ fileName: "r.pdf", mimeType: "application/pdf", url: "https://x/r.pdf" }]);
  });

  it("ends the run when a tool returns endTurn, blocking later calls", async () => {
    let afterCalls = 0;
    const finish = defineTool({
      name: "finish",
      description: "Ends the run with a reply.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: ({ text }) => toolResult({ endTurn: { reply: text } }),
    });
    const after = defineTool({ name: "after", description: "x", run: () => void afterCalls++ });
    const model = scriptedModel([code(`await finish({ text: "All set." });\ntry { await after(); } catch {}\nreturn 1;`)]);
    const result = await agentWith(model, { tools: [finish, after] }).run("go");
    expect(result.text).toBe("All set.");
    expect(result.stopReason).toBe("end_turn");
    expect(afterCalls).toBe(0);
    expect(model.calls).toBe(1);
  });

  it("injects tool images as a user turn and switches that step to the vision model", async () => {
    const shot = defineTool({
      name: "screenshot",
      description: "Takes a screenshot.",
      run: () => toolResult({ value: "captured", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] }),
    });
    const model = scriptedModel([
      code(`return await screenshot();`),
      (req) => {
        const imageTurn = req.messages.find((m) => m.role === "user" && m.files?.length);
        expect(imageTurn?.content).toContain("1 image from screenshot");
        expect(req.model).toBe("test:vision");
        return text("I see it.");
      },
    ]);
    const result = await agentWith(model, { tools: [shot], visionModel: "test:vision" }).run("look");
    expect(result.text).toBe("I see it.");
    expect(model.requests[0].model).toBe("test:model");
  });

  it("uses a loaded skill's model override (last loaded wins)", async () => {
    const coding = defineSkill({ name: "coding", description: "Code", model: "test:coder" });
    const model = scriptedModel([useSkills("weather", "coding"), text("ok")]);
    await agentWith(model, { skills: [weatherSkill, coding] }).run("x");
    expect(model.requests[0].model).toBe("test:model");
    expect(model.requests[1].model).toBe("test:coder");
  });

  it("withdraws use_skills after its budget and blocks exact repeats", async () => {
    const other = defineSkill({ name: "other", description: "Other" });
    const model = scriptedModel([
      useSkills("weather"),
      useSkills("other"),
      (req) => {
        expect(req.functions?.map((f) => f.name)).toEqual(["execute_code"]);
        return code(`return 1;`);
      },
      code(`return 1;`),
      code(`return 1;`),
      (req) => {
        expect(lastToolResult(req)).toContain("You already ran exactly this execute_code call twice");
        return text("stop");
      },
    ]);
    const result = await agentWith(model, { skills: [weatherSkill, other] }).run("x");
    expect(result.text).toBe("stop");
  });

  it("retries when a tool call arrives as plain text", async () => {
    const model = scriptedModel([
      text('<execute_code>{"code":"return 1"}</execute_code>'),
      (req) => {
        expect(req.messages[req.messages.length - 1].content).toContain("written as plain text");
        return text("fixed");
      },
    ]);
    const result = await agentWith(model).run("x");
    expect(result.text).toBe("fixed");
  });

  it("hits the iteration cap, forces a text step, then wraps up", async () => {
    const model = scriptedModel([
      code(`return "a";`),
      code(`return "b";`),
      (req) => {
        // Last iteration: tools stay declared but function_call is "none"
        expect(req.function_call).toBe("none");
        return code(`return "c";`);
      },
      (req) => {
        expect(req.messages[req.messages.length - 1].content).toContain("The tool phase is over");
        return text("Here is what I found.");
      },
    ]);
    const result = await agentWith(model, { limits: { maxExecuteCalls: 2, maxUseSkillsCalls: 0 } }).run("x");
    expect(result.stopReason).toBe("wrap_up");
    expect(result.text).toBe("Here is what I found.");
  });

  it("keeps sandbox state across execute_code calls and seeds state.messages", async () => {
    const model = scriptedModel([
      code(`state.n = state.messages.length; return "stored";`),
      code(`return state.n;`),
      (req) => text(/<return_value>\s+2\s/.test(lastToolResult(req)) ? "yes" : lastToolResult(req)),
    ]);
    const result = await agentWith(model).run([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(result.text).toBe("yes");
  });

  it("renders class contexts and skill contexts once", async () => {
    class Clock extends BaseContext {
      readonly tag = "clock";
      build() {
        return "noon";
      }
    }
    const withCtx = defineSkill({ name: "timed", description: "Timed", contexts: [Clock] });
    const model = scriptedModel([
      useSkills("timed"),
      (req) => {
        expect(lastToolResult(req)).toContain("<clock>");
        return text("ok");
      },
    ]);
    await agentWith(model, { skills: [withCtx] }).run("x");
  });

  it("aborts with AbortedError when the signal fires", async () => {
    const controller = new AbortController();
    const model = scriptedModel([
      (req) => {
        controller.abort();
        return code(`return 1;`);
      },
    ]);
    await expect(agentWith(model).run("x", { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
  });

  it("rejects bad definitions early", () => {
    expect(() => defineTool({ name: "bad-name", description: "x", run: () => 1 })).toThrow(/identifier/);
    expect(() => defineSkill({ name: "ok", description: "" })).toThrow(/description/);
    expect(() => new Agent({ model: "" })).toThrow(/model/);
  });
});

describe("toModelCallError", () => {
  it("keeps status and provider message but drops the request (and its API key)", async () => {
    const { toModelCallError } = await import("../src/model");
    const axiosLike = Object.assign(new Error("Request failed with status code 400"), {
      config: { headers: { "x-api-key": "sk-secret" } },
      request: { _header: "x-api-key: sk-secret" },
      response: { status: 400, data: { error: { message: "usage limit reached" } } },
    });
    const clean = toModelCallError(axiosLike);
    expect(clean.message).toBe("Model call failed (400): usage limit reached");
    expect(JSON.stringify(clean, Object.getOwnPropertyNames(clean))).not.toContain("sk-secret");
    expect((clean as any).cause).toBeUndefined();
  });
});
