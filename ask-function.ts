// Edge Function: ask (v4 - conversational + ambient capture)
// Chat message + recent turns in -> grounded/labeled answer out immediately;
// ambient pipeline (triage -> draft -> dedup -> file) continues via EdgeRuntime.waitUntil.
// B0: only Max's words are ever filed. Assistant turns are context, never source material.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const ANSWER_MODEL = "claude-sonnet-5";
const DRAFT_MODEL = "claude-sonnet-5";
const TRIAGE_MODEL = "claude-haiku-4-5";

// Tunable via Edge Function secrets - no redeploy needed.
const SIM_THRESHOLD = Number(Deno.env.get("SIM_THRESHOLD") ?? "0") || 0; // answer retrieval filter
const MATCH_COUNT = Number(Deno.env.get("MATCH_COUNT") ?? "8") || 8;
const CAND_THRESHOLD = Number(Deno.env.get("CAND_THRESHOLD") ?? "0.4") || 0.4; // dedup net (permissive)
const SESSION_GUARD_MIN = Number(Deno.env.get("SESSION_GUARD_MIN") ?? "60") || 60; // same-occasion window

const ANSWER_SYSTEM = [
  "You are Alleah, Max's personal memory assistant. His memory folders model what HE knows - they are not the boundary of what YOU know.",
  "Answer in two clearly separated registers:",
  "1. FROM HIS MEMORY - claims grounded in the numbered folders. Cite inline like [1], [2].",
  "2. GENERAL KNOWLEDGE - your broader knowledge, used freely but ALWAYS explicitly marked as such (e.g. 'You haven't filed anything on this, but generally...').",
  "Rules:",
  "- Never present general knowledge as if it came from his folders. Unlabeled sourcing is the one unforgivable failure; knowing things is not.",
  "- If nothing relevant is filed: say so plainly, answer anyway from general knowledge (marked), and offer to file his own take on it.",
  "- If Max asks you to file something or gives his own take, acknowledge it - filing happens automatically in the background from his words.",
  "- Where genuinely interesting, briefly note gaps or odd shapes in his filed knowledge - an observant colleague, not a nagging audit.",
  "- Be concise, direct, conversational.",
].join("\n");

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

async function anthropic(body: Record<string, unknown>) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Claude API: " + (await r.text()));
  return await r.json();
}

async function voyage(texts: string[], inputType: "query" | "document") {
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + Deno.env.get("VOYAGE_API_KEY")!,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "voyage-4", input: texts, input_type: inputType }),
  });
  if (!r.ok) throw new Error("Voyage API: " + (await r.text()));
  return (await r.json()).data.map((d: { embedding: number[] }) => d.embedding);
}

function toolUse(am: { content?: { type: string }[] }) {
  return (am.content || []).find((c: { type: string }) => c.type === "tool_use") as
    | { name: string; input: Record<string, unknown> }
    | undefined;
}

// ============ Ambient pipeline (background) ============

// deno-lint-ignore no-explicit-any
async function ambientPipeline(supabase: any, turns: { role: string; content: string }[], newest: string, newestEmbedding: number[], matches: { id: string; similarity: number }[]) {
  try {
    const windowText = turns
      .map((t) => (t.role === "user" ? "MAX: " : "ALLEAH: ") + t.content)
      .join("\n");

    // --- Triage (Haiku): newest message only; window is context ---
    const triage = await anthropic({
      model: TRIAGE_MODEL,
      max_tokens: 300,
      system: [
        "You triage Max's NEWEST message for his personal knowledge memory. The earlier turns are context for interpreting it - only the newest message is candidate material.",
        "Routes:",
        "- found_knowledge: the newest message asserts, explains, or reasons about something Max knows, believes, prefers, or does. Include short answers that complete an idea started earlier (context makes them meaningful).",
        "- question: the newest message is primarily Max asking something he wants to know.",
        "- nothing_to_file: commands, chatter, acknowledgements, small talk, pure meta-instructions.",
        "Assistant turns are NEVER source material. When unsure between knowledge and nothing, prefer nothing.",
      ].join("\n"),
      tools: [
        { name: "found_knowledge", description: "Newest message contains Max's knowledge worth drafting.", input_schema: { type: "object", properties: { gist: { type: "string" } }, required: ["gist"] } },
        { name: "question", description: "Newest message is a question Max is asking.", input_schema: { type: "object", properties: { question_text: { type: "string" } }, required: ["question_text"] } },
        { name: "nothing_to_file", description: "No knowledge here.", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "Conversation window:\n" + windowText + "\n\nNEWEST message from Max: " + newest }],
    });
    const route = toolUse(triage);
    console.log("triage", JSON.stringify({ msg: newest.slice(0, 80), route: route?.name }));

    if (!route || route.name === "nothing_to_file") return;

    // --- Questions are gap signal, not knowledge (B6) ---
    if (route.name === "question") {
      const ins = await supabase.from("queries").insert({
        question_text: newest,
        embedding: newestEmbedding,
        matched_folder_ids: matches.map((m) => m.id),
        top_similarity: matches[0]?.similarity ?? null,
      });
      if (ins.error) console.log("queries_insert_error", ins.error.message);
      return;
    }

    // --- Drafting (Sonnet, tool-enforced, epistemic tagging B5) ---
    const drafting = await anthropic({
      model: DRAFT_MODEL,
      max_tokens: 2000,
      system: [
        "You are the filing clerk for Max's personal knowledge memory.",
        "Draft atomic folders from Max's NEWEST message only, using earlier turns as context to resolve references. Never file the assistant's words or ideas.",
        "- Each folder: exactly ONE idea, 3-5 sentences, self-contained (no unresolved references).",
        "- title: short and specific. type: concept | project | person | note.",
        "- Preserve Max's actual views and facts. No filler, no invention.",
        "- epistemic: 'explained' if he explains it in his own words or uses it as analogy; 'stated' if he asserts it with reason; 'hedged' if partial, exploring, or thinking out loud. Exploring is NOT believing - bias toward hedged when in doubt.",
        "- If on reflection there is no real idea here, use nothing_to_file.",
      ].join("\n"),
      tools: [
        {
          name: "file_folders",
          description: "File Max's newest message as atomic folders.",
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
                    epistemic: { type: "string", enum: ["hedged", "stated", "explained"] },
                  },
                  required: ["title", "type", "body", "epistemic"],
                },
              },
            },
            required: ["folders"],
          },
        },
        { name: "nothing_to_file", description: "No real idea here after all.", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "Conversation window:\n" + windowText + "\n\nNEWEST message from Max: " + newest }],
    });
    const drafted = toolUse(drafting);
    if (!drafted || drafted.name !== "file_folders") {
      console.log("draft", JSON.stringify({ outcome: "nothing_to_file" }));
      return;
    }
    const drafts = (drafted.input.folders ?? []) as { title: string; type: string; body: string; epistemic: string }[];

    // --- Dedup with five outcomes (B4 + same-occasion guard) ---
    const userTurnTexts = turns.filter((t) => t.role === "user").map((t) => t.content);
    for (const draft of drafts) {
      const [emb] = await voyage([draft.title + "\n" + draft.body], "document");
      const rpc = await supabase.rpc("match_folders", { query_embedding: emb, match_count: 3 });
      const cands = rpc.data ?? [];
      console.log("dedup_scores", JSON.stringify({
        draft: draft.title.slice(0, 50),
        scores: cands.map((c: { title: string; similarity: number }) => ({ t: c.title.slice(0, 40), s: Math.round(c.similarity * 1000) / 1000 })),
      }));
      const best = cands[0];

      // Outcome: NEW (nothing near the net)
      if (!best || best.similarity < CAND_THRESHOLD) {
        await fileNew(supabase, draft, emb, newest);
        console.log("outcome", JSON.stringify({ draft: draft.title.slice(0, 50), outcome: "new" }));
        continue;
      }

      const full = await supabase.from("folders")
        .select("id,title,body,source,updated_at,metadata")
        .eq("id", best.id).single();
      if (full.error) { console.log("dedup_fetch_error", full.error.message); continue; }
      const existing = full.data;

      // Outcome: SAME OCCASION - no bump, no write, no classifier call
      const src = (existing.source || "").slice(0, 400);
      const overlaps = src && userTurnTexts.some((t) =>
        src.includes(t.slice(0, 80)) || t.includes(src.slice(0, 80))
      );
      const ageMin = (Date.now() - new Date(existing.updated_at).getTime()) / 60000;
      if (overlaps || ageMin < SESSION_GUARD_MIN) {
        console.log("outcome", JSON.stringify({ draft: draft.title.slice(0, 50), outcome: "same_occasion", folder: existing.id }));
        continue;
      }

      // Outcomes: echo / refinement / contradiction / new (Haiku is the judge)
      const cls = await anthropic({
        model: TRIAGE_MODEL,
        max_tokens: 400,
        system: [
          "Classify the relationship between an EXISTING memory folder and a NEW draft of Max's knowledge.",
          "- echo: same idea restated, no meaningful new content.",
          "- refinement: same idea with meaningfully more detail or precision.",
          "- contradiction: Max's position has changed - the new draft conflicts with the existing folder.",
          "- new: actually a different idea despite surface similarity.",
        ].join("\n"),
        tools: [{
          name: "classify",
          description: "Classify the relationship.",
          input_schema: {
            type: "object",
            properties: {
              outcome: { type: "string", enum: ["echo", "refinement", "contradiction", "new"] },
              rationale: { type: "string" },
            },
            required: ["outcome", "rationale"],
          },
        }],
        tool_choice: { type: "tool", name: "classify" },
        messages: [{ role: "user", content: "EXISTING folder:\n" + existing.title + "\n" + existing.body + "\n\nNEW draft:\n" + draft.title + "\n" + draft.body }],
      });
      const verdict = toolUse(cls)!.input as { outcome: string; rationale: string };
      console.log("outcome", JSON.stringify({ draft: draft.title.slice(0, 50), outcome: verdict.outcome, folder: existing.id, rationale: verdict.rationale.slice(0, 120) }));

      const meta = existing.metadata || {};
      if (verdict.outcome === "echo") {
        await supabase.from("folders")
          .update({ metadata: { ...meta, strength: (meta.strength || 1) + 1 } })
          .eq("id", existing.id);
      } else if (verdict.outcome === "refinement") {
        const [newEmb] = await voyage([existing.title + "\n" + draft.body], "document");
        await supabase.from("folders")
          .update({ body: draft.body, embedding: newEmb, metadata: { ...meta, strength: (meta.strength || 1) + 1, epistemic: draft.epistemic } })
          .eq("id", existing.id);
      } else if (verdict.outcome === "contradiction") {
        const created = await fileNew(supabase, draft, emb, newest);
        if (created) {
          await supabase.from("links").insert({
            source_id: created.id,
            target_id: existing.id,
            relationship: "supersedes",
            origin: "auto",
            is_leap: false,
            verified: true,
            confidence: best.similarity,
            rationale: verdict.rationale,
          });
        }
      } else {
        await fileNew(supabase, draft, emb, newest);
      }
    }
  } catch (e) {
    console.log("ambient_error", String(e));
  }
}

// deno-lint-ignore no-explicit-any
async function fileNew(supabase: any, draft: { title: string; type: string; body: string; epistemic: string }, emb: number[], sourceText: string) {
  const valid = ["concept", "project", "person", "note"];
  const ins = await supabase.from("folders").insert({
    title: draft.title,
    type: valid.includes(draft.type) ? draft.type : "note",
    body: draft.body,
    embedding: emb,
    source: sourceText,
    metadata: { epistemic: draft.epistemic, strength: 1, origin: "ambient" },
  }).select("id").single();
  if (ins.error) { console.log("file_error", ins.error.message); return null; }
  return ins.data;
}

// ============ Request handler ============

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
    // Accepts {messages: [{role, content}...]} - newest user message last. {question} kept for compat.
    const turns: { role: string; content: string }[] =
      body.messages ?? (body.question ? [{ role: "user", content: body.question }] : []);
    const newest = [...turns].reverse().find((t) => t.role === "user")?.content?.trim();
    if (!newest) return json({ error: "No user message" }, 400);
    const window = turns.slice(-10);

    // Retrieval for the answer
    const [qEmbedding] = await voyage([newest], "query");
    const rpc = await supabase.rpc("match_folders", { query_embedding: qEmbedding, match_count: MATCH_COUNT });
    if (rpc.error) return json({ error: rpc.error.message }, 500);
    const all = rpc.data ?? [];
    console.log("ask_scores", JSON.stringify({
      q: newest.slice(0, 100),
      threshold: SIM_THRESHOLD,
      scores: all.map((m: { title: string; similarity: number }) => ({ t: m.title.slice(0, 50), s: Math.round(m.similarity * 1000) / 1000 })),
    }));
    const matches = all.filter((m: { similarity: number }) => m.similarity >= SIM_THRESHOLD);

    const context = matches.length
      ? matches.map((m: { title: string; type: string; body: string }, i: number) =>
        "[" + (i + 1) + "] " + m.title + " (" + m.type + ")\n" + m.body).join("\n\n")
      : "(no relevant folders found for this message)";

    const am = await anthropic({
      model: ANSWER_MODEL,
      max_tokens: 1500,
      system: ANSWER_SYSTEM + "\n\nMax's memory folders relevant to his latest message:\n\n" + context,
      messages: window.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.content })),
    });
    const textBlock = (am.content || []).find((c: { type: string }) => c.type === "text") as { text?: string } | undefined;
    const answer = textBlock?.text || "";

    // Ambient capture continues after the response returns (B1) - survives client disconnect.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(
      ambientPipeline(supabase, window, newest, qEmbedding, matches),
    ) ?? ambientPipeline(supabase, window, newest, qEmbedding, matches);

    return json({
      answer,
      folders: matches.map((m: { id: string; title: string; type: string; similarity: number }, i: number) => ({
        n: i + 1, id: m.id, title: m.title, type: m.type,
        similarity: Math.round(m.similarity * 100) / 100,
      })),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
