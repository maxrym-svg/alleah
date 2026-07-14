// Edge Function: capture (v4 - tool-call enforced drafting)
// Dictated thought -> Claude drafts atomic folders via forced tool call (shape enforced
// at the API level) -> voyage-4 embeddings -> saved under the signed-in user (RLS).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-5";
const SYSTEM = [
  "You are the filing clerk for Max's personal knowledge memory.",
  "Turn the dictated thought into one or more atomic folders using the file_folders tool.",
  "Rules:",
  "- Each folder captures exactly ONE idea in 3-5 sentences, self-contained enough to understand alone (no unresolved references like 'this' pointing outside the folder).",
  "- title: short and specific. type: one of concept | project | person | note.",
  "- Preserve Max's actual views and facts. Do not add filler or invent details.",
  "- Split multi-idea inputs into multiple folders.",
  "- Only if the input is genuinely too ambiguous to file (you cannot tell what is meant), use the ask_clarification tool with ONE question instead of filing.",
].join("\n");

const TOOLS = [
  {
    name: "file_folders",
    description: "File the dictated thought as one or more atomic folders.",
    input_schema: {
      type: "object",
      properties: {
        folders: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              type: { type: "string", enum: ["concept", "project", "person", "note"] },
              body: { type: "string" },
            },
            required: ["title", "type", "body"],
          },
        },
      },
      required: ["folders"],
    },
  },
  {
    name: "ask_clarification",
    description: "Ask ONE clarifying question when the input is genuinely too ambiguous to file.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

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

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await supabase.auth.getUser();
    if (!userData || !userData.user) return json({ error: "Not signed in" }, 401);

    const body = await req.json();
    const original = body.original_text ?? body.text;
    const input = body.clarification_answer
      ? "Original thought: " + body.original_text +
        "\nAnswer to your clarifying question: " + body.clarification_answer
      : body.text;
    if (!input || !input.trim()) return json({ error: "Empty input" }, 400);

    // 1) Claude drafts atomic folders - forced tool call, shape enforced by the API
    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: TOOLS,
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: input }],
      }),
    });
    if (!ar.ok) return json({ error: "Claude API: " + (await ar.text()) }, 502);
    const am = await ar.json();

    const toolUse = (am.content || []).find((c: { type: string }) => c.type === "tool_use");
    let folders = [];
    if (toolUse && toolUse.name === "ask_clarification") {
      return json({ clarification: toolUse.input.question });
    } else if (toolUse && toolUse.name === "file_folders") {
      folders = toolUse.input.folders ?? [];
    } else {
      // Backstop: tolerant text parse (should not happen with tool_choice "any")
      const textBlock = (am.content || []).find((c: { type: string }) => c.type === "text");
      const raw = (textBlock && textBlock.text) || "";
      const s = raw.indexOf("{");
      const e = raw.lastIndexOf("}");
      if (s === -1 || e === -1) return json({ error: "No usable drafting output" }, 502);
      try {
        const draft = JSON.parse(raw.slice(s, e + 1));
        if (draft.clarification) return json({ clarification: draft.clarification });
        folders = draft.folders ?? [];
      } catch (_e) {
        return json({ error: "Could not parse drafting output: " + raw.slice(0, 200) }, 502);
      }
    }
    if (!folders.length) return json({ error: "Nothing to file" }, 422);

    // 2) voyage-4 embeddings (1024 dims, document side)
    const vr = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + Deno.env.get("VOYAGE_API_KEY")!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "voyage-4",
        input: folders.map((f: { title: string; body: string }) => f.title + "\n" + f.body),
        input_type: "document",
      }),
    });
    if (!vr.ok) return json({ error: "Voyage API: " + (await vr.text()) }, 502);
    const ve = await vr.json();

    // 3) Save (user JWT -> RLS applies; user_id defaults to auth.uid())
    const valid = ["concept", "project", "person", "note"];
    const rows = folders.map((f: { title: string; type: string; body: string }, i: number) => ({
      title: f.title,
      type: valid.includes(f.type) ? f.type : "note",
      body: f.body,
      embedding: ve.data[i].embedding,
      source: original,
    }));
    const ins = await supabase.from("folders").insert(rows)
      .select("id,title,type,body,created_at");
    if (ins.error) return json({ error: ins.error.message }, 500);
    return json({ saved: ins.data });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
