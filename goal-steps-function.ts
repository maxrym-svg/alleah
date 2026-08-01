// Edge Function: goal-steps (authenticated)
// Generates 4-6 mini-objectives for a goal via one Haiku call. The REAL backend
// for the Goals tab's generate feature - built after repeated preview attempts
// failed against a call with nothing behind it. JWT verified (default).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: userData } = await supabase.auth.getUser();
    if (!userData || !userData.user) return json({ error: "Not signed in" }, 401);

    let body: { title?: unknown; description?: unknown; difficulty?: unknown };
    try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
    if (typeof body.title !== "string" || !body.title.trim()) {
      return json({ error: "expected { title }" }, 400);
    }
    const title = body.title.trim().slice(0, 200);
    const description = typeof body.description === "string" ? body.description.slice(0, 600) : "";
    const difficulty = typeof body.difficulty === "string" ? body.difficulty.slice(0, 20) : "medium";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        system: "Break a personal goal into concrete mini-objectives. Each step: short (under 12 words), actionable, concrete, ordered from first to last. 4 steps for easy goals, 5 for medium/hard, 6 for epic. Steps must be specific to THIS goal, never generic filler.",
        tools: [{
          name: "steps",
          description: "Return the mini-objectives.",
          input_schema: {
            type: "object",
            properties: { steps: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } } },
            required: ["steps"],
          },
        }],
        tool_choice: { type: "tool", name: "steps" },
        messages: [{ role: "user", content: "Goal: " + title + "\nDifficulty: " + difficulty + (description ? "\nDescription: " + description : "") }],
      }),
    });
    if (!r.ok) {
      console.log("goal_steps_api_error", (await r.text()).slice(0, 200));
      return json({ error: "generation failed" }, 502);
    }
    const am = await r.json();
    const tu = (am.content || []).find((c: { type: string }) => c.type === "tool_use") as
      | { input?: { steps?: unknown } } | undefined;
    const steps = Array.isArray(tu?.input?.steps)
      ? (tu!.input!.steps as unknown[]).filter((s) => typeof s === "string").map((s) => (s as string).slice(0, 120)).slice(0, 6)
      : [];
    if (!steps.length) return json({ error: "generation failed" }, 502);
    return json({ steps });
  } catch (e) {
    console.log("goal_steps_error", String(e).slice(0, 200));
    return json({ error: "server error" }, 500);
  }
});
