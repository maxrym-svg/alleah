// Edge Function: ask (v4.3 - dual-flag triage: exploration files as provisional knowledge; questions always log as gaps)
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
  "- If nothing relevant is filed on a topic he asks about: say so plainly and answer anyway from general knowledge (marked).",
  "- Filing is automatic and silent. NEVER ask permission to file, never announce that you will file something, never ask him to repeat things for filing.",
  "- Follow-up questions come from genuine conversational interest in what he just said - like 'That's lovely - what's her name?' - NEVER from a checklist. There is no canonical set of fields for a person, project, or anything else; memory is as thin or thick as conversation makes it. Never track completeness, never work toward filling a record's 'missing' attributes.",
  "- At most ONE follow-up, then let it go. If he never gives a detail, be comfortable never knowing it. Never re-ask something he declined or ignored. A friend who asks one interested question is warm; one who fills every blank is doing an intake interview.",
  "- The understanding checkpoint: when Max has been working through a topic and seems to have landed somewhere, your one follow-up is best spent on 'so how would you put it in your own words?'. His restatement is what his memory keeps - the conclusion, not the staircase. Use it sparingly, at real resolution points only.",
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

    // --- Triage (Haiku): dual-flag assessment - a message can be question AND knowledge ---
    const triage = await anthropic({
      model: TRIAGE_MODEL,
      max_tokens: 400,
      system: [
        "You assess Max's NEWEST message for his personal knowledge memory. Earlier turns are context for interpreting it - only the newest message is candidate material.",
        "Two INDEPENDENT flags - both can be true when both are true:",
        "- contains_question: he is asking something he wants to know. A plain request ('what is X?') is a question and NOTHING more - it must never count as knowledge. The gap log depends on pure requests staying pure.",
        "- contains_knowledge: he asserts, explains, or reasons about something he knows, believes, prefers, or does - including facts about his life, his people, and his plans (e.g. 'I'm going to my sister's grad today' = he has a sister, graduating today). Short answers completing an earlier idea count.",
        "The key distinction: REQUESTING information is not knowledge; TESTING HIS OWN MODEL is. 'So X works like Y because Z, right?' is him proposing a model - that is knowledge (mode: exploration) even though it ends in a question mark, and it is usually ALSO a question.",
        "knowledge_mode: 'exploration' when he is working out a model / hypothesis under test; 'belief' when he holds or states it.",
        "When genuinely unsure whether a question hides a proposed model, lean toward contains_knowledge=true with mode exploration - a stray exploration fold is cheap; a discarded insight is gone. But never do this for plain requests.",
        "Neither flag: commands, chatter, acknowledgements, meta-instructions. Assistant turns are NEVER source material.",
      ].join("\n"),
      tools: [{
        name: "assess",
        description: "Assess the newest message.",
        input_schema: {
          type: "object",
          properties: {
            contains_question: { type: "boolean" },
            question_text: { type: "string" },
            contains_knowledge: { type: "boolean" },
            knowledge_mode: { type: "string", enum: ["belief", "exploration"] },
            gist: { type: "string" },
          },
          required: ["contains_question", "contains_knowledge"],
        },
      }],
      tool_choice: { type: "tool", name: "assess" },
      messages: [{ role: "user", content: "Conversation window:\n" + windowText + "\n\nNEWEST message from Max: " + newest }],
    });
    const assess = toolUse(triage)?.input as {
      contains_question: boolean; question_text?: string;
      contains_knowledge: boolean; knowledge_mode?: string;
    } | undefined;
    console.log("triage", JSON.stringify({
      msg: newest.slice(0, 80),
      question: !!assess?.contains_question,
      knowledge: !!assess?.contains_knowledge,
      mode: assess?.knowledge_mode ?? null,
    }));
    if (!assess) return;

    // --- Questions are gap signal (B6) - logged even when the message also holds knowledge ---
    if (assess.contains_question) {
      const ins = await supabase.from("queries").insert({
        question_text: assess.question_text || newest,
        embedding: newestEmbedding,
        matched_folder_ids: matches.map((m) => m.id),
        top_similarity: matches[0]?.similarity ?? null,
      });
      if (ins.error) console.log("queries_insert_error", ins.error.message);
    }
    if (!assess.contains_knowledge) return;

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
        "- File what IS said. Missing details (a name, a date) are never a reason to withhold filing - state the fact without the unknown, e.g. 'Max has a sister (name not yet known) who graduates today.' Later answers will refine it.",
        "- epistemic: 'explained' if he explains it in his own words or uses it as analogy; 'stated' if he asserts it with reason; 'hedged' if partial, exploring, or thinking out loud. Exploring is NOT believing - bias toward hedged when in doubt.",
        "- solicited: true when this material answers a question the assistant just asked (check the previous assistant turn); false when Max raised it himself, unprompted. Volunteered material is evidence of what's on his mind; solicited material mostly reflects what the assistant chose to ask.",
        "- exploration: true when the folder captures a model Max is working out or testing ('so X works like Y?'), false when it is something he holds or states. An exploration fold should read as his current working model, phrased as his proposal.",
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
                    solicited: { type: "boolean" },
                    exploration: { type: "boolean" },
                  },
                  required: ["title", "type", "body", "epistemic", "solicited", "exploration"],
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
    const drafts = (drafted.input.folders ?? []) as { title: string; type: string; body: string; epistemic: string; solicited: boolean; exploration: boolean }[];
    console.log("capture_stats", JSON.stringify({
      drafts: drafts.length,
      volunteered: drafts.filter((d) => !d.solicited).length,
      solicited: drafts.filter((d) => d.solicited).length,
      exploration: drafts.filter((d) => d.exploration).length,
    }));

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
        console.log("outcome", JSON.stringify({ draft: draft.title.slice(0, 50), outcome: "new", solicited: !!draft.solicited, mode: draft.exploration ? "exploration" : "belief" }));
        continue;
      }

      const full = await supabase.from("folders")
        .select("id,title,body,source,updated_at,metadata")
        .eq("id", best.id).single();
      if (full.error) { console.log("dedup_fetch_error", full.error.message); continue; }
      const existing = full.data;

      // Same-occasion detection gates the STRENGTH BUMP only - it never blocks filing
      // or classification. (A time-based filing veto silently swallowed distinct new
      // ideas that loosely resembled a just-touched folder.)
      const src = (existing.source || "").slice(0, 400);
      const overlaps = src && userTurnTexts.some((t) =>
        src.includes(t.slice(0, 80)) || t.includes(src.slice(0, 80))
      );
      const ageMin = (Date.now() - new Date(existing.updated_at).getTime()) / 60000;
      const sameOccasion = !!overlaps || ageMin < SESSION_GUARD_MIN;
      // Conviction = repeated on separate occasions, volunteered - not extracted.
      const countsAsConviction = !sameOccasion && !draft.solicited;

      // Outcomes: echo / refinement / contradiction / new (Haiku is always the judge)
      const cls = await anthropic({
        model: TRIAGE_MODEL,
        max_tokens: 400,
        system: [
          "Classify the relationship between an EXISTING memory folder and a NEW draft of Max's knowledge.",
          "- echo: same idea restated, no meaningful new content.",
          "- refinement: same idea with meaningfully more detail, precision, or resolution.",
          "- contradiction: Max's position has changed - the new draft conflicts with the existing folder.",
          "- new: actually a different idea despite surface similarity.",
          "If the existing folder was updated minutes ago and both address the same question, they are likely the SAME ongoing exploration - the new draft revises the old thinking. Strongly prefer refinement (or contradiction if he reversed) over new in that case. An exploration should resolve into one evolving folder, not a staircase of parallel guesses.",
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
      console.log("outcome", JSON.stringify({
        draft: draft.title.slice(0, 50), outcome: verdict.outcome, folder: existing.id,
        solicited: !!draft.solicited, same_occasion: sameOccasion, bumps: countsAsConviction,
        mode: draft.exploration ? "exploration" : "belief",
        rationale: verdict.rationale.slice(0, 120),
      }));

      const meta = existing.metadata || {};
      if (verdict.outcome === "echo") {
        if (countsAsConviction) {
          await supabase.from("folders")
            .update({ metadata: { ...meta, strength: (meta.strength || 1) + 1 } })
            .eq("id", existing.id);
        }
        // same-occasion or solicited echo: no write at all
      } else if (verdict.outcome === "refinement") {
        // Refinements always update content (solicited answers can thicken folders);
        // only conviction-grade repeats bump strength. A non-exploration refinement
        // RESOLVES an exploration thread: the conclusion replaces the working-out,
        // and the exploration mark is cleared.
        const [newEmb] = await voyage([existing.title + "\n" + draft.body], "document");
        const newMeta = { ...meta, strength: (meta.strength || 1) + (countsAsConviction ? 1 : 0), epistemic: draft.epistemic } as Record<string, unknown>;
        if (draft.exploration) newMeta.mode = "exploration";
        else delete newMeta.mode;
        await supabase.from("folders")
          .update({ body: draft.body, embedding: newEmb, metadata: newMeta })
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
async function fileNew(supabase: any, draft: { title: string; type: string; body: string; epistemic: string; solicited?: boolean; exploration?: boolean }, emb: number[], sourceText: string) {
  const valid = ["concept", "project", "person", "note"];
  const metadata: Record<string, unknown> = { epistemic: draft.epistemic, strength: 1, origin: "ambient", solicited: !!draft.solicited };
  if (draft.exploration) metadata.mode = "exploration";
  const ins = await supabase.from("folders").insert({
    title: draft.title,
    type: valid.includes(draft.type) ? draft.type : "note",
    body: draft.body,
    embedding: emb,
    source: sourceText,
    metadata,
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
